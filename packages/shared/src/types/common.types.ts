// ────────────────────────────────────────────────────────────
// Common Utility Types — Shared generic types
// ────────────────────────────────────────────────────────────

/** Paginated response wrapper */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Health check response for GET /health */
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptime: number;
}

/** Generic success response */
export interface SuccessResponse {
  success: boolean;
}

/** Make selected properties required */
export type RequireFields<T, K extends keyof T> = T & Required<Pick<T, K>>;
