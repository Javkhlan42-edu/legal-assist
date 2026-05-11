import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@legal-chatbot/shared';
import { planChatWorkflow } from '../../src/services/chat-workflow.service.ts';
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
  it('continues a short evidence follow-up from the previous legal snapshot without retrieval', () => {
    const plan = planChatWorkflow({
      message: 'Ямар баримт бүрдүүлэх хэрэгтэй вэ?',
      history: makeLaborDismissalHistory(),
      messageRecords: [makeLaborDismissalSnapshotRecord()],
    });

    expect(plan.earlyResponse).toBeUndefined();
    expect(plan.scope.scope).toBe('legal');
    expect(plan.intent).toBe('labor');
    expect(plan.usesHistoryContext).toBe(true);
    expect(plan.carryForwardMode).toBe('clarify_skip_retrieval');
    expect(plan.shouldSkipRetrieval).toBe(true);
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
    expect(plan.carryForwardMode).toBe('clarify_skip_retrieval');
    expect(plan.shouldSkipRetrieval).toBe(true);
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
});
