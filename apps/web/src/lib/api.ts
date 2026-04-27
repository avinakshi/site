import type { Problem } from '@csm-chat/shared';

export const API_URL =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:4000';

let accessToken: string | null = null;
const subscribers = new Set<(t: string | null) => void>();

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  subscribers.forEach((cb) => cb(token));
}

export function onAccessTokenChange(cb: (t: string | null) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem | null;
  constructor(status: number, problem: Problem | null, fallback: string) {
    super(problem?.detail ?? problem?.title ?? fallback);
    this.status = status;
    this.problem = problem;
  }
}

async function asProblem(res: Response): Promise<Problem | null> {
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.includes('json')) return null;
  try {
    return (await res.json()) as Problem;
  } catch {
    return null;
  }
}

export interface ApiOptions extends RequestInit {
  /** Send Authorization: Bearer header. */
  auth?: boolean;
  /** JSON body — auto-stringified. Pass `FormData` etc as plain `body` instead. */
  json?: unknown;
}

let inflightRefresh: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    const res = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) {
      setAccessToken(null);
      return false;
    }
    const body = (await res.json()) as { accessToken: string };
    setAccessToken(body.accessToken);
    return true;
  })();
  try {
    return await inflightRefresh;
  } finally {
    inflightRefresh = null;
  }
}

/**
 * Centralized fetch wrapper. Handles JSON serialization, credentials,
 * Bearer auth, and one-shot 401 → /refresh → retry.
 */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { auth = false, json, headers: incomingHeaders, ...rest } = opts;

  const buildHeaders = (): Headers => {
    const h = new Headers(incomingHeaders);
    if (json !== undefined) h.set('content-type', 'application/json');
    if (auth && accessToken) h.set('authorization', `Bearer ${accessToken}`);
    return h;
  };

  const init: RequestInit = {
    ...rest,
    credentials: 'include',
    headers: buildHeaders(),
    body: json !== undefined ? JSON.stringify(json) : (rest.body as BodyInit | null | undefined),
  };

  let res = await fetch(`${API_URL}${path}`, init);

  if (res.status === 401 && auth) {
    const ok = await tryRefresh();
    if (ok) {
      res = await fetch(`${API_URL}${path}`, { ...init, headers: buildHeaders() });
    }
  }

  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const problem = await asProblem(res);
    throw new ApiError(res.status, problem, `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}
