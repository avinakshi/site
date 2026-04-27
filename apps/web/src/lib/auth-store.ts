import { create } from 'zustand';
import type { User } from '@csm-chat/shared';
import { api, setAccessToken } from './api';

interface AuthState {
  user: User | null;
  /** True until the initial /refresh attempt has resolved one way or the other. */
  initializing: boolean;
  /** Loads the current session by exchanging the csm_refresh cookie for an access token. */
  bootstrap(): Promise<void>;
  login(email: string, password: string): Promise<User>;
  logout(): Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  initializing: true,

  async bootstrap() {
    try {
      const res = await fetch(`${getApiUrl()}/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        setAccessToken(null);
        set({ user: null, initializing: false });
        return;
      }
      const body = (await res.json()) as { accessToken: string };
      setAccessToken(body.accessToken);
      const me = await api<User>('/v1/auth/me', { auth: true });
      set({ user: me, initializing: false });
    } catch {
      setAccessToken(null);
      set({ user: null, initializing: false });
    }
  },

  async login(email, password) {
    const res = await api<{ accessToken: string; user: User }>('/v1/auth/login', {
      method: 'POST',
      json: { email, password },
    });
    setAccessToken(res.accessToken);
    set({ user: res.user, initializing: false });
    return res.user;
  },

  async logout() {
    try {
      await api<void>('/v1/auth/logout', { method: 'POST' });
    } catch {
      /* logout is idempotent; swallow */
    }
    setAccessToken(null);
    set({ user: null });
  },
}));

function getApiUrl(): string {
  return (
    (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || 'http://localhost:4000'
  );
}
