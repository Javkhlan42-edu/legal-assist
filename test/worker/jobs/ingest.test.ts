// ────────────────────────────────────────────────────────────
// Ingestion Job Tests
// ────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runSourcePipelineMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerWarnMock = vi.fn();
const loggerErrorMock = vi.fn();

vi.mock('../../../apps/worker/src/services/pipeline.service.js', () => ({
  pipelineService: {
    runSourcePipeline: runSourcePipelineMock,
  },
}));

vi.mock('../../../apps/worker/src/config/env.js', () => ({
  getWorkerEnv: () => ({
    CHROMA_URL: 'http://localhost:8000',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/legal_chatbot',
    PIPELINE_FAIL_FAST: true,
    PIPELINE_MAX_ERROR_RATE: 0.3,
    PIPELINE_MAX_CONSECUTIVE_FAILURES: 5,
    PIPELINE_MAX_RETRIES_PER_DOC: 3,
    PIPELINE_RETRY_BASE_MS: 750,
    PIPELINE_MIN_HTML_LENGTH: 120,
    PIPELINE_MIN_TEXT_LENGTH: 120,
    PIPELINE_DEAD_LETTER_DIR: 'data/processed/dead-letter',
  }),
}));

vi.mock('../../../apps/worker/src/lib/logger.js', () => ({
  createLogger: () => ({
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
  }),
}));

function buildStats(overrides: Partial<any> = {}) {
  return {
    source: 'legalinfo',
    startTime: new Date(),
    endTime: new Date(),
    durationMs: 1000,
    documentsDiscovered: 2,
    documentsFetched: 2,
    documentsParsed: 2,
    documentsSkipped: 0,
    documentsFailed: 0,
    totalChunks: 8,
    chunksEmbedded: 8,
    chunksUpserted: 8,
    duplicateChunksSkipped: 0,
    deadLetteredDocuments: 0,
    errors: [],
    ...overrides,
  };
}

describe('runIngestionJob', () => {
  beforeEach(() => {
    runSourcePipelineMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('runs pipeline for known source with reliability config', async () => {
    runSourcePipelineMock.mockResolvedValue(buildStats());

    const { runIngestionJob } = await import('../../../apps/worker/src/jobs/ingest.js');
    await runIngestionJob({ sources: ['legalinfo'], limit: 10 });

    expect(runSourcePipelineMock).toHaveBeenCalledTimes(1);
    expect(runSourcePipelineMock).toHaveBeenCalledWith(
      'legalinfo',
      expect.objectContaining({
        maxDocuments: 10,
        failFast: true,
        maxErrorRate: 0.3,
        maxConsecutiveFailures: 5,
        maxRetriesPerDocument: 3,
      }),
    );
  });

  it('throws when fail-fast is enabled and pipeline returns errors', async () => {
    runSourcePipelineMock.mockResolvedValue(
      buildStats({
        documentsFailed: 1,
        errors: [{ stage: 'process', url: 'https://example.com', error: 'boom' }],
        deadLetteredDocuments: 1,
      }),
    );

    const { runIngestionJob } = await import('../../../apps/worker/src/jobs/ingest.js');

    await expect(runIngestionJob({ sources: ['legalinfo'], limit: 2 })).rejects.toThrow(
      /Fail-fast enabled/,
    );
  });

  it('skips unknown sources', async () => {
    const { runIngestionJob } = await import('../../../apps/worker/src/jobs/ingest.js');
    await runIngestionJob({ sources: ['unknown'], limit: 5 });

    expect(runSourcePipelineMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalled();
  });
});
