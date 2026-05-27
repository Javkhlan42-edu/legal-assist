// ────────────────────────────────────────────────────────────
// Follow-up classifier — LLM-driven topic continuity detection
// ────────────────────────────────────────────────────────────
//
// Determines whether the current user message continues a prior topic, asks for
// more detail on the previous answer, switches to a new legal area, or is a
// greeting / out-of-scope chit-chat.
//
// Used by the workflow planner as a stronger signal than the existing regex
// patterns. The result is consumed in two ways:
//   1. To decide carryForwardMode (`reuse_same_law` vs `full_refresh`).
//   2. To decide how many history turns to forward into the generation prompt.
//
// The classifier is intentionally cheap: a single chat completion at low
// temperature with strict JSON output. Returns `null` on any failure so the
// caller can fall back to the deterministic heuristics.

import type { ChatMessage } from '@legal-chatbot/shared';
import type { AppEnv } from '../config/env.js';
import { chatCompletion, getOpenAIClient } from '../lib/llm-client.js';

export type FollowUpKind =
  | 'new_topic'
  | 'same_topic'
  | 'related_topic'
  | 'detail_followup'
  | 'greeting'
  | 'out_of_scope';

export interface FollowUpHint {
  kind: FollowUpKind;
  /** 1-based index of the prior user turn this message references, if any. */
  referencedTurnIndex?: number;
  /** Confidence reported by the classifier (0..1). */
  confidence: number;
}

const SYSTEM_PROMPT = `Та хэрэглэгчийн одоогийн мессежийг өмнөх ярианд хэрхэн холбогдож байгааг ангилах туслах.
Зөвхөн дараах нэг утгыг буцаа:
- "same_topic" — өмнөх асуудлынхаа дэлгэрэнгүй, нөхцөл, баримтыг үргэлжлүүлэн асууж байгаа.
- "detail_followup" — өмнөх хариултын тодорхой хэсгийг ("яаж?", "хэдэн хоног?", "хаашаа хандах вэ?") нарийвчлан асууж байгаа.
- "related_topic" — салбар нь ойролцоо ч шинэ нөхцөл нэмж байгаа (жишээ: ослын асуултын дараа даатгал ярьж байгаа).
- "new_topic" — огт өөр хууль зүйн салбар руу шилжсэн.
- "greeting" — мэндчилгээ, баярлалаа, чи хэн бэ гэх мэт яриа.
- "out_of_scope" — хууль зүйн бус бол (хоол, кино, програм, спорт г.м).

Хариултыг ЗААВАЛ ганц JSON хэлбэрээр буцаа: {"kind":"<утга>","referencedTurnIndex":<тоо эсвэл null>,"confidence":<0..1>}.
referencedTurnIndex нь хэрэв одоогийн мессеж тодорхой өмнөх хэрэглэгчийн асуултыг нарийн заасан бол түүний 1-ээс эхлэх дугаар. Бусад тохиолдолд null.
Тайлбар, нэмэлт текст, markdown бичихгүй.`;

interface ClassifyOptions {
  env: AppEnv;
  message: string;
  history: ChatMessage[];
}

const MIN_MESSAGE_LENGTH = 3;
const MAX_HISTORY_TURNS_FOR_CLASSIFIER = 6;

export async function classifyFollowUp(opts: ClassifyOptions): Promise<FollowUpHint | null> {
  const { env, message, history } = opts;

  if (!env.OPENAI_API_KEY?.trim()) {
    return null;
  }

  const trimmed = message.trim();
  if (trimmed.length < MIN_MESSAGE_LENGTH) {
    return null;
  }

  if (history.length === 0) {
    return null;
  }

  const recentUserTurns = history
    .filter((m) => m.role === 'user')
    .slice(-MAX_HISTORY_TURNS_FOR_CLASSIFIER);

  if (recentUserTurns.length === 0) {
    return null;
  }

  const turnList = recentUserTurns
    .map((m, idx) => `[${idx + 1}] ${truncate(m.content, 240)}`)
    .join('\n');

  const lastAssistant = history
    .slice()
    .reverse()
    .find((m) => m.role === 'assistant');
  const assistantSnippet = lastAssistant ? truncate(lastAssistant.content, 360) : '';

  try {
    const openai = getOpenAIClient(env.OPENAI_API_KEY, env.OPENAI_TIMEOUT_MS);
    const response = await chatCompletion(
      openai,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            'Өмнөх хэрэглэгчийн асуултууд:',
            turnList,
            '',
            assistantSnippet ? 'Сүүлийн туслагчийн хариултын товч:' : '',
            assistantSnippet,
            '',
            `Одоогийн мессеж: ${truncate(trimmed, 320)}`,
            '',
            'JSON-ыг буцаа.',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        },
      ],
      {
        model: env.OPENAI_CHAT_MODEL,
        temperature: 0.1,
        maxTokens: 160,
      },
    );

    return parseClassifierResponse(response.text);
  } catch (error) {
    console.warn(
      `[follow-up-classifier] failed (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

function truncate(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) {
    return compact;
  }

  return `${compact.slice(0, max - 1)}…`;
}

function parseClassifierResponse(raw: string): FollowUpHint | null {
  if (!raw) {
    return null;
  }

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const jsonCandidate = cleaned.slice(start, end + 1);
  try {
    const parsed = JSON.parse(jsonCandidate) as {
      kind?: unknown;
      referencedTurnIndex?: unknown;
      confidence?: unknown;
    };
    const kind = normalizeKind(String(parsed.kind ?? ''));
    if (!kind) {
      return null;
    }

    const referencedTurnIndexRaw = parsed.referencedTurnIndex;
    const referencedTurnIndex =
      typeof referencedTurnIndexRaw === 'number' && Number.isFinite(referencedTurnIndexRaw)
        ? Math.max(1, Math.floor(referencedTurnIndexRaw))
        : undefined;

    const confidenceRaw = parsed.confidence;
    const confidence =
      typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
        ? Math.max(0, Math.min(1, confidenceRaw))
        : 0.6;

    return { kind, referencedTurnIndex, confidence };
  } catch {
    return null;
  }
}

function normalizeKind(raw: string): FollowUpKind | null {
  const value = raw.trim().toLowerCase();
  switch (value) {
    case 'same_topic':
    case 'detail_followup':
    case 'related_topic':
    case 'new_topic':
    case 'greeting':
    case 'out_of_scope':
      return value;
    default:
      return null;
  }
}
