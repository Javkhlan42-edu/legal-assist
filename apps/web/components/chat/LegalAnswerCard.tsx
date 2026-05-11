'use client';

import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { RelatedCase, RelatedLaw, Source } from '@legal-chatbot/shared';
import { DecisionFlowchart, extractFlowSteps } from './DecisionFlowchart';
import { RelatedCases } from './RelatedCases';
import type { Components } from 'react-markdown';

// ── Law ID lookup for building citation URLs ──

const LAW_ID_MAP: Record<string, string> = {
  ИХ: '299',
  ЭХ: '12172',
  ЗТ: '12695',
  ЗХАБТХ: '11224',
  ХЭХТХ: '101004',
  ГБХ: '226',
  ГБТ: '226',
  ГБТХ: '226',
  ГБХТТ: '12393',
  ГБХТТХ: '12393',
  ХХҮТ: '11223',
  ХХҮТХ: '11223',
  ХТ: '16230709635751',
  ХТХ: '16230709635751',
  ЭХШТ: '12694',
  ЭХХШТ: '12694',
  ИХШ: '12694',
  ИХШТ: '11220',
  ЦАТ: '12469',
  ЦАТХ: '12469',
  ХХТХ: '523',
  АТ: '29',
};

const TITLE_ABBREV_RULES: Array<{ pattern: RegExp; abbrevs: string[] }> = [
  { pattern: /ГЭР\s+БҮЛИЙН\s+ТУХАЙ/i, abbrevs: ['ГБТ', 'ГБХ', 'ГБТХ'] },
  { pattern: /ХҮҮХДИЙН\s+ЭРХИЙН\s+ТУХАЙ/i, abbrevs: ['ХЭТ', 'ХЭТХ'] },
  { pattern: /ХҮҮХЭД\s+ХАМГААЛЛЫН\s+ТУХАЙ/i, abbrevs: ['ХХТ', 'ХХТХ'] },
  { pattern: /ХАРИЛЦАА\s+ХОЛБООНЫ\s+ТУХАЙ/i, abbrevs: ['ХХТ', 'ХХТХ'] },
  { pattern: /АВТОТЭЭВРИЙН\s+ТУХАЙ/i, abbrevs: ['АТ'] },
  { pattern: /ЦАГДААГИЙН\s+АЛБАНЫ\s+ТУХАЙ/i, abbrevs: ['ЦАТ', 'ЦАТХ'] },
  { pattern: /ХҮҮХЭД\s+ХАРАХ\s+ҮЙЛЧИЛГЭЭНИЙ\s+ТУХАЙ/i, abbrevs: ['ХХҮТ', 'ХХҮТХ'] },
  { pattern: /ИРГЭНИЙ\s+ХУУЛЬ/i, abbrevs: ['ИХ'] },
  { pattern: /ЭРҮҮГИЙН\s+ХУУЛЬ/i, abbrevs: ['ЭХ'] },
  { pattern: /ЗӨРЧЛИЙН\s+ТУХАЙ/i, abbrevs: ['ЗТ'] },
  { pattern: /ХӨДӨЛМӨРИЙН\s+ТУХАЙ/i, abbrevs: ['ХТ', 'ХТХ'] },
  {
    pattern: /ИРГЭНИЙ\s+ХЭРЭГ\s+ШҮҮХЭД\s+ХЯНАН\s+ШИЙДВЭРЛЭХ\s+ТУХАЙ/i,
    abbrevs: ['ИХШТ'],
  },
  { pattern: /ЭРҮҮГИЙН\s+ХЭРЭГ\s+ХЯНАН\s+ШИЙДВЭРЛЭХ\s+ТУХАЙ/i, abbrevs: ['ЭХХШТ', 'ЭХШТ'] },
];

const LAW_ABBREV_BY_ID = Object.fromEntries(
  Object.entries(LAW_ID_MAP).map(([abbrev, lawId]) => [lawId, abbrev]),
) as Record<string, string>;

function normalizeLawAbbrev(abbrev: string): string {
  return abbrev
    .replace(/-ийн$|-ын$|-н$/i, '')
    .trim()
    .toUpperCase();
}

function normalizeArticleNo(articleNo: string): string {
  return articleNo
    .replace(/§/g, '')
    .replace(/\s*(?:дүгээр|дугаар)\s+зүйл.*/i, '')
    .replace(/[^\d.]/g, '')
    .replace(/\.+$/g, '')
    .trim();
}

function buildLegalinfoCitationSword(articleNo: string): string {
  return normalizeArticleNo(articleNo);
}

function buildCitationKey(abbrev: string, articleNo: string): string {
  return `${normalizeLawAbbrev(abbrev)}:${articleNo.trim()}`;
}

function buildWildcardCitationKey(abbrev: string): string {
  return `${normalizeLawAbbrev(abbrev)}:*`;
}

function buildCitationUrlFromBase(urlValue: string, articleNo: string): string {
  if (!urlValue) return '';

  try {
    const url = new URL(urlValue);
    if (articleNo) {
      const normalizedArticle = normalizeArticleNo(articleNo);
      const existingSword = url.searchParams.get('sword') ?? '';
      if (existingSword && normalizedArticle && existingSword.includes(normalizedArticle)) {
        return url.toString();
      }

      const sword = buildLegalinfoCitationSword(articleNo);
      if (sword) {
        url.searchParams.set('sword', sword);
      }
    }
    return url.toString();
  } catch {
    return urlValue;
  }
}

function buildCitationUrl(abbrev: string, articleNo: string): string | null {
  const clean = normalizeLawAbbrev(abbrev);
  const lawId = LAW_ID_MAP[clean];
  if (!lawId) return null;
  const sword = encodeURIComponent(buildLegalinfoCitationSword(articleNo));
  return `https://legalinfo.mn/mn/detail?lawId=${lawId}&sword=${sword}`;
}

function getAbbrevCandidatesFromSource(source: Source): string[] {
  const candidates = new Set<string>();

  if (source.lawId) {
    const fromLawId = LAW_ABBREV_BY_ID[source.lawId];
    if (fromLawId) {
      candidates.add(fromLawId);
    }
  }

  const title = String(source.title ?? '').trim();
  if (title) {
    for (const rule of TITLE_ABBREV_RULES) {
      if (rule.pattern.test(title)) {
        for (const abbrev of rule.abbrevs) {
          candidates.add(abbrev);
        }
      }
    }
  }

  return Array.from(candidates);
}

function buildCitationLookup(sources?: Source[]): Map<string, string> {
  const lookup = new Map<string, string>();

  for (const source of sources ?? []) {
    if (!source.url) continue;
    const abbrevs = getAbbrevCandidatesFromSource(source);
    for (const abbrev of abbrevs) {
      lookup.set(buildWildcardCitationKey(abbrev), source.url);
      if (source.articleNo) {
        lookup.set(buildCitationKey(abbrev, source.articleNo), source.url);
      }
    }
  }

  return lookup;
}

function resolveCitationUrl(
  abbrev: string,
  articleNo: string,
  citationLookup?: Map<string, string>,
): string | null {
  const mappedUrl = citationLookup?.get(buildCitationKey(abbrev, articleNo));
  if (mappedUrl) return mappedUrl;

  const wildcardUrl = citationLookup?.get(buildWildcardCitationKey(abbrev));
  if (wildcardUrl) {
    return buildCitationUrlFromBase(wildcardUrl, articleNo);
  }

  return buildCitationUrl(abbrev, articleNo);
}

function parseCitationLabel(text: string): { abbrev: string; articleNo: string } | null {
  const normalized = text.trim();
  let match = normalized.match(
    /([А-ЯӨҮЁа-яөүё]{1,12})\s*[-–—]?\s*(?:ийн|ын|н)\s*§\s*(\d+(?:\.\d+)*)/u,
  );
  if (match) {
    return { abbrev: match[1], articleNo: match[2] };
  }

  match = normalized.match(
    /([А-ЯӨҮЁа-яөүё]{1,12})\s*[-–—]?\s*(?:ийн|ын|н)\s*(\d+(?:\.\d+)*)\s*(?:дүгээр|дугаар)\s+зүйл/u,
  );
  if (match) {
    return { abbrev: match[1], articleNo: match[2] };
  }

  return null;
}

// ── Parse LLM answer into structured sections ──

interface ParsedAnswer {
  summary: string;
  mainBody: string;
  practicalTips: string;
}

const SECTION_PATTERNS = {
  practicalTips: /^\*\*(?:Практик зөвлөгөө|Анхааруулга|⚠️)/i,
  heading: /^\*\*[^*]+\*\*$|^#{1,3}\s/,
};

function parseAnswerSections(content: string): ParsedAnswer {
  const lines = content.split('\n');
  const summaryLines: string[] = [];
  const mainLines: string[] = [];
  const tipsLines: string[] = [];

  let section: 'summary' | 'main' | 'tips' = 'summary';
  let foundFirstHeading = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (SECTION_PATTERNS.practicalTips.test(trimmed)) {
      section = 'tips';
      tipsLines.push(line);
      continue;
    }

    if (!foundFirstHeading && section === 'summary') {
      if (SECTION_PATTERNS.heading.test(trimmed) || /^\*\*\d+\./.test(trimmed)) {
        foundFirstHeading = true;
        section = 'main';
        mainLines.push(line);
        continue;
      }
      summaryLines.push(line);
      continue;
    }

    if (section === 'tips') {
      tipsLines.push(line);
    } else {
      mainLines.push(line);
    }
  }

  return {
    summary: summaryLines.join('\n').trim(),
    mainBody: mainLines.join('\n').trim(),
    practicalTips: tipsLines.join('\n').trim(),
  };
}

// ── Transform inline citations to clickable chips ──

function transformCitations(text: string, citationLookup?: Map<string, string>): string {
  return text
    .replace(
      /(?<!\[)([А-ЯӨҮЁа-яөүё]{1,12})\s*[-–—]?\s*(?:ийн|ын|н)\s*§\s*(\d+(?:\.\d+)*)/g,
      (match, abbrev, articleNo) => {
        const url = resolveCitationUrl(abbrev, articleNo, citationLookup);
        if (url) return `[${abbrev}-ийн §${articleNo}](${url})`;
        return match;
      },
    )
    .replace(
      /(?<!\[)([А-ЯӨҮЁа-яөүё]{1,12})\s*[-–—]?\s*(?:ийн|ын|н)\s*(\d+(?:\.\d+)*)\s*(?:дүгээр|дугаар)\s+зүйл/g,
      (match, abbrev, articleNo) => {
        const url = resolveCitationUrl(abbrev, articleNo, citationLookup);
        if (url) return `[${abbrev}-ийн ${articleNo} дугаар зүйл](${url})`;
        return match;
      },
    );
}

// ── Custom markdown renderers ──

function buildMarkdownComponents(citationLookup: Map<string, string>): Components {
  return {
    a: ({ href, children, ...props }) => {
      const text = String(children ?? '');
      const parsedCitation = parseCitationLabel(text);
      // Preserve LLM-provided sword parameter if present
      const hrefHasSword = href?.includes('sword=') && href?.includes('legalinfo.mn');
      const resolvedHref = hrefHasSword
        ? href
        : parsedCitation?.abbrev && parsedCitation.articleNo
          ? (resolveCitationUrl(parsedCitation.abbrev, parsedCitation.articleNo, citationLookup) ??
            href)
          : href;
      const isLegal = resolvedHref?.includes('legalinfo.mn');

      if (isLegal) {
        return (
          <a
            href={resolvedHref}
            target="_blank"
            rel="noopener noreferrer"
            className="legal-citation-chip"
            {...props}
          >
            <svg
              className="h-3 w-3 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            {text}
          </a>
        );
      }

      return (
        <a
          href={resolvedHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary-600 dark:text-primary-400 underline hover:no-underline"
          {...props}
        >
          {children}
        </a>
      );
    },
    blockquote: ({ children, ...props }) => (
      <blockquote
        className="my-1.5 border-l-[3px] border-blue-300 bg-blue-50/50 py-1 pl-3 text-[13px] italic text-gray-600 dark:border-blue-600 dark:bg-blue-900/10 dark:text-gray-400"
        {...props}
      >
        {children}
      </blockquote>
    ),
  };
}

// ── Sub-components ──

interface LegalAnswerCardProps {
  content: string;
  relatedCases?: RelatedCase[];
  relatedLaws?: RelatedLaw[];
  confidence?: number;
  sourcesUsed?: number;
  sources?: Source[];
  elapsedMs?: number;
}

function SectionHeader({
  icon,
  title,
  color,
}: {
  icon: React.ReactNode;
  title: string;
  color: string;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <div className={`flex h-6 w-6 items-center justify-center rounded-lg ${color}`}>{icon}</div>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
    </div>
  );
}

function ScaleIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        d="M12 3v18M3 7l9-4 9 4M3 7l3 6c.5 1.5 2 3 6 3s5.5-1.5 6-3l3-6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LightbulbIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        d="M9 21h6M12 3a6 6 0 014 10.5V17H8v-3.5A6 6 0 0112 3z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AnalyticsIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M4 19V5M10 19v-8M16 19v-5M22 19H2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RelevanceBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const bg =
    pct >= 80
      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
      : pct >= 60
        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
        : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400';
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${bg}`}>{pct}% холбогдол</span>
  );
}

function RelatedLawCards({ laws }: { laws: RelatedLaw[] }) {
  if (!laws || laws.length === 0) return null;
  return (
    <div className="space-y-2">
      {laws.map((law, idx) => (
        <div
          key={`${law.url}-${idx}`}
          className="group flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2.5 transition hover:border-blue-300 hover:shadow-sm dark:border-gray-700 dark:bg-gray-800/50 dark:hover:border-blue-600/50"
        >
          <div className="min-w-0 flex-1">
            {law.url ? (
              <a
                href={law.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] font-medium text-gray-900 transition hover:text-blue-600 dark:text-gray-100 dark:hover:text-blue-400"
              >
                {law.title}
              </a>
            ) : (
              <span className="text-[13px] font-medium text-gray-900 dark:text-gray-100">
                {law.title}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <RelevanceBadge score={law.displayScore ?? law.score} />
            {law.url && (
              <a
                href={law.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-medium text-blue-600 transition hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
              >
                legalinfo &rarr;
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function InsightBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-full border border-white/70 bg-white/85 px-3 py-1.5 text-xs shadow-sm dark:border-gray-700/70 dark:bg-gray-900/70">
      <span className="font-semibold text-gray-900 dark:text-gray-100">{value}</span>
      <span className="ml-1 text-gray-500 dark:text-gray-400">{label}</span>
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface CollapsibleSectionProps {
  icon: React.ReactNode;
  title: string;
  color: string;
  count?: number;
  preview?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function CollapsibleSection({
  icon,
  title,
  color,
  count,
  preview,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <section className="legal-section">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex w-full items-start justify-between gap-3 rounded-xl border border-gray-200 bg-white/70 px-3 py-3 text-left transition hover:border-gray-300 hover:bg-gray-50/80 dark:border-gray-700 dark:bg-gray-800/35 dark:hover:border-gray-600 dark:hover:bg-gray-800/50"
        aria-expanded={isOpen}
      >
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${color}`}
          >
            {icon}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
              {typeof count === 'number' && count > 0 && (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                  {count}
                </span>
              )}
            </div>
            {preview && (
              <p className="mt-1 line-clamp-1 text-xs text-gray-500 dark:text-gray-400">
                {preview}
              </p>
            )}
          </div>
        </div>
        <div className="mt-0.5 flex shrink-0 items-center gap-1 text-xs font-medium text-gray-500 dark:text-gray-400">
          <span>{isOpen ? 'Хураах' : 'Дэлгэрүүлэх'}</span>
          <ChevronIcon open={isOpen} />
        </div>
      </button>

      {isOpen && <div className="mt-3">{children}</div>}
    </section>
  );
}

// ── Render Markdown with citation transformation ──

function LegalMarkdown({ text, sources }: { text: string; sources?: Source[] }) {
  const citationLookup = useMemo(() => buildCitationLookup(sources), [sources]);
  const transformed = useMemo(
    () => transformCitations(text, citationLookup),
    [text, citationLookup],
  );
  const markdownComponents = useMemo(
    () => buildMarkdownComponents(citationLookup),
    [citationLookup],
  );
  return (
    <div className="prose-chat text-sm leading-relaxed text-gray-800 dark:text-gray-200">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {transformed}
      </ReactMarkdown>
    </div>
  );
}

// ── Main Component ──

export function LegalAnswerCard({
  content,
  relatedCases,
  relatedLaws,
  confidence,
  sourcesUsed,
  sources,
  elapsedMs,
}: LegalAnswerCardProps) {
  const parsed = useMemo(() => parseAnswerSections(content), [content]);
  const flowSteps = useMemo(() => extractFlowSteps(parsed.mainBody), [parsed.mainBody]);
  const sortedRelatedLaws = useMemo(
    () => [...(relatedLaws ?? [])].sort((a, b) => b.score - a.score),
    [relatedLaws],
  );
  const primaryLaw = sortedRelatedLaws[0];
  const secondaryLaws = sortedRelatedLaws.slice(1);
  const secondaryLawPreview = secondaryLaws[0]?.title ?? '';
  const resolvedSourceCount = sourcesUsed ?? sources?.length ?? 0;
  const confidenceLabel =
    typeof confidence === 'number' && Number.isFinite(confidence)
      ? `${Math.max(0, Math.min(100, Math.round(confidence * 100)))}%`
      : null;

  return (
    <div className="legal-answer-card space-y-4">
      {(confidenceLabel ||
        resolvedSourceCount > 0 ||
        (relatedCases?.length ?? 0) > 0 ||
        elapsedMs != null) && (
        <section className="rounded-xl border border-slate-200 bg-gradient-to-r from-slate-50 via-white to-amber-50/60 p-3 dark:border-slate-700 dark:from-slate-900/60 dark:via-gray-900 dark:to-amber-950/10">
          <SectionHeader
            icon={<AnalyticsIcon />}
            title="Answer Insights"
            color="bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
          />
          <div className="flex flex-wrap gap-2">
            {confidenceLabel && <InsightBadge label="confidence" value={confidenceLabel} />}
            {resolvedSourceCount > 0 && (
              <InsightBadge label="sources" value={String(resolvedSourceCount)} />
            )}
            {(relatedCases?.length ?? 0) > 0 && (
              <InsightBadge label="cases" value={String(relatedCases?.length ?? 0)} />
            )}
            {elapsedMs != null && elapsedMs > 0 && (
              <InsightBadge label="latency" value={`${(elapsedMs / 1000).toFixed(1)}s`} />
            )}
          </div>
        </section>
      )}

      {/* Primary related law */}
      {primaryLaw && (
        <section className="legal-section">
          <SectionHeader
            icon={<ScaleIcon />}
            title="Хамааралтай хууль (1)"
            color="bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
          />
          <RelatedLawCards laws={[primaryLaw]} />
        </section>
      )}

      {/* Additional related laws */}
      {secondaryLaws.length > 0 && (
        <CollapsibleSection
          icon={<ScaleIcon />}
          title="Бусад хамааралтай хуулиуд"
          count={secondaryLaws.length}
          preview={secondaryLawPreview}
          color="bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
        >
          <RelatedLawCards laws={secondaryLaws} />
        </CollapsibleSection>
      )}

      {relatedCases && relatedCases.length > 0 && <RelatedCases cases={relatedCases} />}

      {/* AI Answer */}
      <section className="legal-section">
        <SectionHeader
          icon={<SparklesIcon />}
          title="Legal Analysis"
          color="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
        />

        {/* Summary paragraph */}
        {parsed.summary && (
          <div className="mb-3">
            <LegalMarkdown text={parsed.summary} sources={sources} />
          </div>
        )}

        {/* Main body with citations */}
        {parsed.mainBody && (
          <div className="rounded-lg border border-gray-100 bg-gray-50/50 p-4 dark:border-gray-700/40 dark:bg-gray-800/30">
            <LegalMarkdown text={parsed.mainBody} sources={sources} />
          </div>
        )}
      </section>

      {/* Decision Flowchart */}
      {flowSteps.length >= 2 && (
        <section className="legal-section">
          <DecisionFlowchart steps={flowSteps} />
        </section>
      )}

      {/* Practical Tips / Warning */}
      {parsed.practicalTips && (
        <section className="legal-section">
          <SectionHeader
            icon={<LightbulbIcon />}
            title="Практик зөвлөгөө"
            color="bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
          />
          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-800/30 dark:bg-amber-900/10">
            <LegalMarkdown text={parsed.practicalTips} sources={sources} />
          </div>
        </section>
      )}

      {/* Sources footer */}
      {sources && sources.length > 0 && (
        <div className="flex items-center gap-2 border-t border-gray-100 pt-3 dark:border-gray-700/50">
          <svg
            className="h-3.5 w-3.5 text-gray-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <rect x="9" y="3" width="6" height="4" rx="1" />
          </svg>
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {resolvedSourceCount} sources used
          </span>
          {elapsedMs != null && elapsedMs > 0 && (
            <span className="text-xs text-gray-400 dark:text-gray-500">
              &middot; {(elapsedMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      )}
    </div>
  );
}
