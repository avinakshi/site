import type { ChatVerifyResponse, ListMessagesResponse, Message, Problem } from '@csm-chat/shared';
import { API_URL, ApiError } from './api';

async function asProblem(res: Response): Promise<Problem | null> {
  try {
    const ctype = res.headers.get('content-type') ?? '';
    if (!ctype.includes('json')) return null;
    return (await res.json()) as Problem;
  } catch {
    return null;
  }
}

/**
 * Calls POST /v1/chat/verify. Sends the device cookie (csm_chat_device)
 * via credentials: 'include'; receives a fresh sessionJwt + wsToken on
 * success.
 */
export async function chatVerify(token: string): Promise<ChatVerifyResponse> {
  const res = await fetch(`${API_URL}/v1/chat/verify`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const problem = await asProblem(res);
    throw new ApiError(res.status, problem, `chat/verify failed (${res.status})`);
  }
  return (await res.json()) as ChatVerifyResponse;
}

export async function chatListMessages(
  sessionJwt: string,
  opts: { limit?: number; before?: string } = {},
): Promise<ListMessagesResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.before) params.set('before', opts.before);
  const url = `${API_URL}/v1/chat/messages${params.toString() ? `?${params}` : ''}`;
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { authorization: `Bearer ${sessionJwt}` },
  });
  if (!res.ok) {
    const problem = await asProblem(res);
    throw new ApiError(res.status, problem, `chat/messages failed (${res.status})`);
  }
  return (await res.json()) as ListMessagesResponse;
}

export async function chatSendMessage(
  sessionJwt: string,
  content: string,
  clientMessageId: string,
): Promise<Message> {
  const res = await fetch(`${API_URL}/v1/chat/messages`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      authorization: `Bearer ${sessionJwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content, clientMessageId }),
  });
  if (!res.ok) {
    const problem = await asProblem(res);
    throw new ApiError(res.status, problem, `chat/messages POST failed (${res.status})`);
  }
  return (await res.json()) as Message;
}
