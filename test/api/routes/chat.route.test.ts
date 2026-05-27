// ────────────────────────────────────────────────────────────
// Chat Route Tests
// ────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';

describe('POST /v1/chat', () => {
  it.todo('should return 400 for empty message');
  it.todo('should return 400 for missing conversationId');
  it.todo('should return 200 with answer and sources');
  it.todo('should return 429 when rate limited');
  it.todo('should include latencyMs in usage');
});
