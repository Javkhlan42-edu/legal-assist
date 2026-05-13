import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@legal-chatbot/shared';
import {
  planChatWorkflow,
  type FollowUpHint,
} from '../../src/services/chat-workflow.service.ts';
import type { MessageRecord } from '../../src/repositories/conversation.repository.ts';

const LABOR_LAW_ID = '16230709635751';

function makeLaborDismissalHistory(): ChatMessage[] {
  return [
    {
      role: 'user',
      content: 'Ажлаас үндэслэлгүй халагдсан бол яаж шийдвэрлэх вэ?',
    },
    {
      role: 'assistant',
      content:
        'Хөдөлмөрийн маргаанд тушаал, гэрээ, цалингийн баримт, ажил олгогчийн албан хариу зэрэг бичгийн нотолгоо хамгийн үнэ цэнтэй байдаг.',
    },
  ];
}

function makeLaborDismissalSnapshotRecord(): MessageRecord {
  return {
    id: 'assistant-1',
    conversationId: 'conversation-1',
    role: 'assistant',
    content:
      'Хөдөлмөрийн тухай хуульд ажлаас халах үндэслэл, тушаал, баримтжуулалтыг шалгана.',
    createdAt: new Date('2026-04-30T07:00:00.000Z').toISOString(),
    metadata: {
      retrievalSnapshot: {
        query: 'Ажлаас үндэслэлгүй халагдсан бол яаж шийдвэрлэх вэ?',
        intent: 'labor',
        primaryDomain: 'labor',
        keywords: ['ажлаас', 'халсан', 'тушаал', 'баримт'],
        lawIds: [LABOR_LAW_ID],
        lawTitles: ['Хөдөлмөрийн тухай хууль'],
        sources: [
          {
            id: 'source-1',
            title: 'Хөдөлмөрийн тухай хууль',
            url: `https://legalinfo.mn/mn/detail?lawId=${LABOR_LAW_ID}`,
            source: 'legalinfo',
          },
        ],
        relatedLaws: [
          {
            title: 'Хөдөлмөрийн тухай хууль',
            articleNo: '78',
            url: `https://legalinfo.mn/mn/detail?lawId=${LABOR_LAW_ID}`,
            score: 0.87,
          },
        ],
        relatedCases: [],
        contextChunks: [
          {
            id: 'labor-78',
            document:
              '78 дугаар зүйл. Хөдөлмөр эрхлэлтийн харилцаа дуусгавар болох үндэслэл. Ажил олгогч хөдөлмөр эрхлэлтийн харилцааг хуульд заасан үндэслэлээр дуусгавар болгоно.',
            metadata: {
              source: 'legalinfo',
              sourceId: LABOR_LAW_ID,
              lawId: LABOR_LAW_ID,
              title: 'Хөдөлмөрийн тухай хууль',
              url: `https://legalinfo.mn/mn/detail?lawId=${LABOR_LAW_ID}`,
              articleNo: '78',
            },
            score: 0.87,
          },
        ],
      },
    },
  };
}

describe('ChatWorkflowService', () => {
  it('continues a short evidence follow-up from the previous legal snapshot without rerunning retrieval', () => {
    const plan = planChatWorkflow({
      message: 'Ямар баримт бүрдүүлэх хэрэгтэй вэ?',
      history: makeLaborDismissalHistory(),
      messageRecords: [makeLaborDismissalSnapshotRecord()],
    });

    expect(plan.earlyResponse).toBeUndefined();
    expect(plan.scope.scope).toBe('legal');
    expect(plan.intent).toBe('labor');
    expect(plan.usesHistoryContext).toBe(true);
    expect(plan.carryForwardMode).toBe('reuse_same_law');
    expect(plan.shouldSkipRetrieval).toBe(true);
    expect(plan.nodes).not.toContain('retrieve_node');
    expect(plan.carryForwardChunks.length).toBeGreaterThan(0);
  });

  it('continues deadline follow-ups from snapshot context instead of asking for a new legal topic', () => {
    const plan = planChatWorkflow({
      message: 'Хугацаа нь хэтэрсэн үү?',
      history: makeLaborDismissalHistory(),
      messageRecords: [makeLaborDismissalSnapshotRecord()],
    });

    expect(plan.earlyResponse).toBeUndefined();
    expect(plan.scope.scope).toBe('legal');
    expect(plan.intent).toBe('labor');
    expect(plan.carryForwardMode).toBe('reuse_same_law');
    expect(plan.shouldSkipRetrieval).toBe(true);
    expect(plan.nodes).not.toContain('retrieve_node');
  });

  it('combines supplemental bank loan facts with the previous question for retrieval', () => {
    const plan = planChatWorkflow({
      message: 'банкнаас авсан зээл 2 сар төлөөгүй байгаа',
      history: [
        {
          role: 'user',
          content:
            'Зээлийн гэрээнд заасан хугацаанд зээлдэгч зээлээ барагдуулахгүй бол юу болох вэ? ямар хариуцлага хүлээх вэ',
        },
        {
          role: 'assistant',
          content:
            'Илүү зөв хариулахын тулд зээл банкны зээл эсэх, хэдэн сар хоцорсон эсэхийг тодруулна.',
        },
      ],
      messageRecords: [],
    });

    expect(plan.earlyResponse).toBeUndefined();
    expect(plan.scope.scope).toBe('legal');
    expect(plan.intent).toBe('contract');
    expect(plan.usesHistoryContext).toBe(true);
    expect(plan.shouldSkipRetrieval).toBe(false);
    expect(plan.query).toContain('Зээлийн гэрээнд заасан хугацаанд');
    expect(plan.query).toContain('банкнаас авсан зээл 2 сар');
  });

  it('does not promote unrelated non-legal questions just because a legal snapshot exists', () => {
    const plan = planChatWorkflow({
      message: 'Энэ кино санал болго',
      history: makeLaborDismissalHistory(),
      messageRecords: [makeLaborDismissalSnapshotRecord()],
    });

    expect(plan.scope.scope).toBe('non_legal');
    expect(plan.earlyResponse?.mode).toBe('no-info');
    expect(plan.shouldSkipRetrieval).toBe(true);
  });
  it('does not reuse cyber-fraud history for a new consumer refund question', () => {
    const plan = planChatWorkflow({
      message: 'Онлайн дэлгүүрээс авсан бүтээгдэхүүн доголдолтой ирсэн. Буцаалт төлүүлэхийг маргалж болох уу?',
      history: [
        { role: 'user', content: 'цахим луйварт өртсөн бол ямар арга хэмжээ авах вэ' },
        { role: 'assistant', content: 'Банк болон цагдаад яаралтай мэдэгдэнэ.' },
      ],
      messageRecords: [],
    });

    expect(plan.scope.scope).toBe('legal');
    expect(plan.intent).toBe('contract');
    expect(plan.usesHistoryContext).toBe(false);
    expect(plan.shouldSkipRetrieval).toBe(false);
    expect(plan.query).not.toContain('цахим луйвар');
  });

  it('does not carry bank-loan context into a separate insurance compensation question', () => {
    const plan = planChatWorkflow({
      message: 'Даатгалын компани камер бичлэг байхгүй гэдгээр нөхөн төлбөр өгөхгүй байна. Маргалж болох уу?',
      history: [
        { role: 'user', content: 'Банкнаас авсан зээлийг 2 сар төлөөгүй бол ямар хариуцлага үүсэх вэ?' },
        { role: 'assistant', content: 'Зээлийн гэрээ, хүү, алданги, барьцааны нөхцөлийг шалгана.' },
      ],
      messageRecords: [],
    });

    expect(plan.scope.scope).toBe('legal');
    expect(plan.intent).toBe('contract');
    expect(plan.usesHistoryContext).toBe(false);
    expect(plan.carryForwardMode).toBe('full_refresh');
    expect(plan.shouldSkipRetrieval).toBe(false);
    expect(plan.query).not.toContain('Банкнаас авсан зээл');
  });

  describe('followUpHint integration', () => {
    it('returns greeting early response when classifier confidently flags greeting and no snapshot is reusable', () => {
      const hint: FollowUpHint = { kind: 'greeting', confidence: 0.95 };

      const plan = planChatWorkflow({
        message: 'Сайн уу',
        history: [],
        messageRecords: [],
        followUpHint: hint,
      });

      expect(plan.earlyResponse).toBeDefined();
      expect(plan.earlyResponse?.mode).toBe('fallback-general');
      expect(plan.shouldSkipRetrieval).toBe(true);
      expect(plan.nodes).toContain('out_of_scope_node');
      expect(plan.carryForwardMode).toBe('full_refresh');
    });

    it('returns out-of-scope early response when classifier confidently flags out_of_scope with no snapshot', () => {
      const hint: FollowUpHint = { kind: 'out_of_scope', confidence: 0.9 };

      const plan = planChatWorkflow({
        message: 'Энэ кино санал болго',
        history: [],
        messageRecords: [],
        followUpHint: hint,
      });

      expect(plan.earlyResponse).toBeDefined();
      expect(plan.earlyResponse?.mode).toBe('no-info');
      expect(plan.shouldSkipRetrieval).toBe(true);
    });

    it('forces reuse_same_law and history carry-forward when hint says same_topic with prior snapshot', () => {
      const hint: FollowUpHint = { kind: 'same_topic', confidence: 0.85 };

      const plan = planChatWorkflow({
        message: 'Тэгээд яаж шийдэх вэ?',
        history: makeLaborDismissalHistory(),
        messageRecords: [makeLaborDismissalSnapshotRecord()],
        followUpHint: hint,
      });

      expect(plan.earlyResponse).toBeUndefined();
      expect(plan.scope.scope).toBe('legal');
      expect(plan.intent).toBe('labor');
      expect(plan.usesHistoryContext).toBe(true);
      expect(plan.carryForwardMode).toBe('reuse_same_law');
      expect(plan.carryForwardChunks.length).toBeGreaterThan(0);
      expect(plan.shouldSkipRetrieval).toBe(true);
      expect(plan.nodes).not.toContain('retrieve_node');
    });

    it('forces reuse_same_law for detail_followup hint even when the surface form does not match regex patterns', () => {
      const hint: FollowUpHint = { kind: 'detail_followup', confidence: 0.8 };

      const plan = planChatWorkflow({
        message: 'Үүнийг яаж тооцоолох вэ?',
        history: makeLaborDismissalHistory(),
        messageRecords: [makeLaborDismissalSnapshotRecord()],
        followUpHint: hint,
      });

      expect(plan.earlyResponse).toBeUndefined();
      expect(plan.carryForwardMode).toBe('reuse_same_law');
      expect(plan.usesHistoryContext).toBe(true);
      expect(plan.shouldSkipRetrieval).toBe(true);
      expect(plan.nodes).not.toContain('retrieve_node');
    });

    it('wipes carry-forward when hint says new_topic even if regex would have kept it', () => {
      const hint: FollowUpHint = { kind: 'new_topic', confidence: 0.85 };

      const plan = planChatWorkflow({
        message: 'Машинаа худалдсан гэрээ хүчингүй болох уу?',
        history: makeLaborDismissalHistory(),
        messageRecords: [makeLaborDismissalSnapshotRecord()],
        followUpHint: hint,
      });

      expect(plan.earlyResponse).toBeUndefined();
      expect(plan.carryForwardMode).toBe('full_refresh');
      expect(plan.carryForwardChunks.length).toBe(0);
      expect(plan.usesHistoryContext).toBe(false);
    });

    it('ignores low-confidence hint and falls back to regex heuristics', () => {
      const hint: FollowUpHint = { kind: 'new_topic', confidence: 0.2 };

      const plan = planChatWorkflow({
        message: 'Ямар баримт бүрдүүлэх хэрэгтэй вэ?',
        history: makeLaborDismissalHistory(),
        messageRecords: [makeLaborDismissalSnapshotRecord()],
        followUpHint: hint,
      });

      // Regex path should still detect this as a labor dismissal follow-up.
      expect(plan.usesHistoryContext).toBe(true);
      expect(plan.carryForwardMode).toBe('reuse_same_law');
      expect(plan.shouldSkipRetrieval).toBe(true);
      expect(plan.nodes).not.toContain('retrieve_node');
    });
  });
});
