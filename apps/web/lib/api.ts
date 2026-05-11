import type {
  AuthMeResponse,
  AuthSuccessResponse,
  ChatStreamEvent,
  ChatRequest,
  ChatResponse,
  ConversationDetailResponse,
  ConversationsResponse,
  GoogleAuthRequest,
  LoginRequest,
  SignupRequest,
} from '@legal-chatbot/shared';
import { getStoredAccessToken } from './auth-storage';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3001';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorBody: { error: string; message: string },
  ) {
    super(errorBody.message);
    this.name = 'ApiError';
  }
}

export interface ChatStreamHandlers {
  onConversation?: (conversationId: string) => void;
  onStatus?: (stage: 'retrieval' | 'generation' | 'persisting', message: string) => void;
  onDelta?: (delta: string) => void;
  onComplete?: (response: ChatResponse) => void;
  onError?: (error: { error: string; message: string }) => void;
}

async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  accessToken?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }

  const resolvedToken = accessToken ?? getStoredAccessToken();
  if (resolvedToken) {
    headers.set('Authorization', `Bearer ${resolvedToken}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({
      error: 'NETWORK_ERROR',
      message: `Server error: ${response.status}`,
    }));
    throw new ApiError(response.status, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

export async function sendChatMessage(
  request: ChatRequest,
  accessToken?: string,
): Promise<ChatResponse> {
  return apiFetch<ChatResponse>(
    '/v1/chat',
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
    accessToken,
  );
}

export async function streamChatMessage(
  request: ChatRequest,
  handlers: ChatStreamHandlers = {},
  accessToken?: string,
): Promise<ChatResponse> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  });

  const resolvedToken = accessToken ?? getStoredAccessToken();
  if (resolvedToken) {
    headers.set('Authorization', `Bearer ${resolvedToken}`);
  }

  const response = await fetch(`${API_BASE_URL}/v1/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({
      error: 'NETWORK_ERROR',
      message: `Server error: ${response.status}`,
    }));
    throw new ApiError(response.status, body);
  }

  if (!response.body) {
    throw new Error('Streaming is not supported by the current browser.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: ChatResponse | null = null;

  const processBlock = (block: string): void => {
    const event = parseChatStreamEvent(block);
    if (!event) {
      return;
    }

    switch (event.type) {
      case 'conversation':
        handlers.onConversation?.(event.conversationId);
        break;
      case 'status':
        handlers.onStatus?.(event.stage, event.message);
        break;
      case 'delta':
        handlers.onDelta?.(event.delta);
        break;
      case 'complete':
        finalResponse = event.response;
        handlers.onComplete?.(event.response);
        break;
      case 'error':
        handlers.onError?.(event.error);
        throw new ApiError(500, event.error);
      default:
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      processBlock(block);
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    processBlock(buffer);
  }

  if (!finalResponse) {
    throw new Error('Chat stream ended before a final response was received.');
  }

  return finalResponse;
}

function parseChatStreamEvent(block: string): ChatStreamEvent | null {
  const dataLines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());

  if (dataLines.length === 0) {
    return null;
  }

  try {
    return JSON.parse(dataLines.join('\n')) as ChatStreamEvent;
  } catch {
    return null;
  }
}

export async function signup(input: SignupRequest): Promise<AuthSuccessResponse> {
  return apiFetch<AuthSuccessResponse>('/v1/auth/signup', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function login(input: LoginRequest): Promise<AuthSuccessResponse> {
  return apiFetch<AuthSuccessResponse>('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function loginWithGoogle(input: GoogleAuthRequest): Promise<AuthSuccessResponse> {
  return apiFetch<AuthSuccessResponse>('/v1/auth/google', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function fetchCurrentUser(accessToken?: string): Promise<AuthMeResponse> {
  return apiFetch<AuthMeResponse>('/v1/auth/me', { method: 'GET' }, accessToken);
}

export async function fetchConversations(
  limit: number = 50,
  offset: number = 0,
  accessToken?: string,
): Promise<ConversationsResponse> {
  return apiFetch<ConversationsResponse>(
    `/v1/conversations?limit=${limit}&offset=${offset}`,
    { method: 'GET' },
    accessToken,
  );
}

export async function fetchConversation(
  conversationId: string,
  accessToken?: string,
): Promise<ConversationDetailResponse> {
  return apiFetch<ConversationDetailResponse>(
    `/v1/conversations/${encodeURIComponent(conversationId)}`,
    { method: 'GET' },
    accessToken,
  );
}

export async function deleteConversation(
  conversationId: string,
  accessToken?: string,
): Promise<void> {
  return apiFetch<void>(
    `/v1/conversations/${encodeURIComponent(conversationId)}`,
    { method: 'DELETE' },
    accessToken,
  );
}
