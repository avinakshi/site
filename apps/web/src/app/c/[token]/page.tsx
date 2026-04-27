'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { API_URL, ApiError } from '@/lib/api';
import { chatListMessages, chatSendMessage, chatVerify } from '@/lib/chat-api';
import { connectAsClient, type ChatSocket } from '@/lib/socket';
import type { ChatVerifyResponse, Message } from '@csm-chat/shared';

const PAGE_SIZE = 50;

interface AttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

function getAttachment(m: Message): AttachmentRef | null {
  const a = (m.metadata as { attachment?: AttachmentRef } | null)?.attachment;
  if (!a || typeof a.id !== 'string') return null;
  return a;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ChatAttachment({
  message,
  sessionJwt,
}: {
  message: Message;
  sessionJwt: string | null;
}) {
  const att = getAttachment(message);
  if (!att) return null;
  const isImage = att.mimeType.startsWith('image/');

  async function open(): Promise<void> {
    if (!sessionJwt) return;
    try {
      const res = await fetch(`${API_URL}/v1/attachments/${att!.id}`, {
        headers: { authorization: `Bearer ${sessionJwt}` },
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={() => void open()}
      className="block w-full rounded border border-border/40 bg-background/10 px-2 py-1.5 text-left text-xs underline-offset-2 hover:underline"
    >
      <div className="flex items-center gap-2">
        <span className="truncate font-medium">
          {isImage ? '🖼️ ' : '📎 '}
          {att.filename}
        </span>
        <span className="ml-auto shrink-0 opacity-70">{formatBytes(att.sizeBytes)}</span>
      </div>
    </button>
  );
}

type VerifyState =
  | { kind: 'loading' }
  | { kind: 'verified'; data: ChatVerifyResponse }
  | { kind: 'error'; status: number; code: string | null; title: string; detail: string };

type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export default function ClientChatPage() {
  const { token } = useParams<{ token: string }>();
  const [verifyState, setVerifyState] = useState<VerifyState>({ kind: 'loading' });
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [oldestCreatedAt, setOldestCreatedAt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [csmOnline, setCsmOnline] = useState(false);
  const [csmTyping, setCsmTyping] = useState(false);
  const [conn, setConn] = useState<ConnState>('connecting');

  const socketRef = useRef<ChatSocket | null>(null);
  const lastSeenMessageIdRef = useRef<string | null>(null);
  const sessionJwtRef = useRef<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingEmitAtRef = useRef<number>(0);
  // Flag prevents double-mount cleanup in React Strict Mode dev from racing
  // initial verify.
  const verifyAttemptedRef = useRef(false);

  // ── Initial verify ──────────────────────────────────────────────────
  useEffect(() => {
    if (verifyAttemptedRef.current) return;
    verifyAttemptedRef.current = true;
    void (async () => {
      try {
        const data = await chatVerify(token);
        sessionJwtRef.current = data.sessionJwt;
        setVerifyState({ kind: 'verified', data });

        // Initial history load.
        const list = await chatListMessages(data.sessionJwt, { limit: PAGE_SIZE });
        setMessages(list.items);
        setHasMore(list.hasMore);
        setOldestCreatedAt(list.oldestCreatedAt);
        if (list.items.length > 0) {
          lastSeenMessageIdRef.current = list.items[list.items.length - 1]!.id;
        }
      } catch (err) {
        if (err instanceof ApiError) {
          setVerifyState({
            kind: 'error',
            status: err.status,
            code: err.problem?.code ?? null,
            title: err.problem?.title ?? 'Unable to open this chat',
            detail: err.problem?.detail ?? err.message,
          });
        } else {
          setVerifyState({
            kind: 'error',
            status: 0,
            code: null,
            title: 'Network error',
            detail: 'Could not reach the server. Please check your connection.',
          });
        }
      }
    })();
  }, [token]);

  // ── Socket lifecycle ────────────────────────────────────────────────
  // Connects with the most-recent wsToken from /chat/verify. Reconnects
  // by re-calling chatVerify (cookie-bound, so it succeeds without
  // user action) to mint a fresh wsToken plus passes lastSeenMessageId
  // for replay of any messages received while offline.
  useEffect(() => {
    if (verifyState.kind !== 'verified') return;

    let stopped = false;
    const initialWsToken = verifyState.data.wsToken;

    function attach(sock: ChatSocket): void {
      socketRef.current = sock;

      sock.on('connect', () => {
        if (stopped) return;
        setConn('connected');
      });
      sock.on('disconnect', () => {
        if (stopped) return;
        setConn('reconnecting');
        // Try to mint a fresh wsToken and reconnect manually after a beat.
        setTimeout(() => {
          if (stopped) return;
          void reconnectWithFreshToken();
        }, 400);
      });
      sock.on('connect_error', (err) => {
        if (stopped) return;
        // Surface auth failures distinctly so we don't loop forever.
        const msg = err.message ?? '';
        if (msg === 'INVALID_TOKEN' || msg === 'TOKEN_EXPIRED' || msg === 'UNAUTHENTICATED') {
          setConn('reconnecting');
          setTimeout(() => {
            if (stopped) return;
            void reconnectWithFreshToken();
          }, 400);
          return;
        }
        setConn('reconnecting');
      });

      sock.on('message:new', (msg: Message) => {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
        lastSeenMessageIdRef.current = msg.id;
        // A message arriving from the other side ends their typing.
        if (msg.senderType !== 'client') setCsmTyping(false);
      });
      sock.on('presence:csm', (info: { online: boolean }) => {
        setCsmOnline(info.online);
      });
      sock.on('typing:other', (info: { from: string }) => {
        if (info.from !== 'csm') return;
        setCsmTyping(true);
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => setCsmTyping(false), 4000);
      });
    }

    async function reconnectWithFreshToken(): Promise<void> {
      try {
        const fresh = await chatVerify(token);
        sessionJwtRef.current = fresh.sessionJwt;
        if (stopped) return;
        if (socketRef.current) {
          socketRef.current.removeAllListeners();
          socketRef.current.disconnect();
          socketRef.current = null;
        }
        const sock = connectAsClient(fresh.wsToken, lastSeenMessageIdRef.current ?? undefined);
        attach(sock);
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError && (err.status === 410 || err.status === 403)) {
          // Session closed or device kicked us — surface as a fatal error.
          setVerifyState({
            kind: 'error',
            status: err.status,
            code: err.problem?.code ?? null,
            title: err.problem?.title ?? 'Disconnected',
            detail: err.problem?.detail ?? 'This conversation cannot be resumed.',
          });
          setConn('disconnected');
        } else {
          setConn('reconnecting');
          setTimeout(() => {
            if (!stopped) void reconnectWithFreshToken();
          }, 2000);
        }
      }
    }

    setConn('connecting');
    const sock = connectAsClient(initialWsToken, lastSeenMessageIdRef.current ?? undefined);
    attach(sock);

    return () => {
      stopped = true;
      if (socketRef.current) {
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [verifyState, token]);

  // ── Auto-scroll on new messages ─────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // ── Send ────────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || verifyState.kind !== 'verified') return;
    setDraft('');
    setSending(true);
    const clientMessageId = crypto.randomUUID();
    try {
      const sock = socketRef.current;
      if (sock?.connected) {
        const ack = await new Promise<{ ok: boolean; message?: Message; error?: string }>(
          (resolve) =>
            sock.emit(
              'message:send',
              { content, clientMessageId },
              (resp: { ok: boolean; message?: Message; error?: string }) => resolve(resp),
            ),
        );
        if (ack.ok && ack.message) {
          setMessages((prev) =>
            prev.some((m) => m.id === ack.message!.id) ? prev : [...prev, ack.message!],
          );
          lastSeenMessageIdRef.current = ack.message.id;
        }
      } else if (sessionJwtRef.current) {
        // REST fallback when the socket isn't currently connected.
        const msg = await chatSendMessage(sessionJwtRef.current, content, clientMessageId);
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        lastSeenMessageIdRef.current = msg.id;
      }
    } finally {
      setSending(false);
    }
  }, [draft, verifyState]);

  // ── Load earlier messages ───────────────────────────────────────────
  async function loadMore(): Promise<void> {
    if (!oldestCreatedAt || verifyState.kind !== 'verified' || !sessionJwtRef.current) return;
    try {
      const data = await chatListMessages(sessionJwtRef.current, {
        limit: PAGE_SIZE,
        before: oldestCreatedAt,
      });
      setMessages((prev) => [...data.items, ...prev]);
      setHasMore(data.hasMore);
      setOldestCreatedAt(data.oldestCreatedAt ?? oldestCreatedAt);
    } catch {
      /* swallow — banner already shows offline state */
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  // Throttled typing emit (at most once every 2s while typing).
  function emitTyping(): void {
    const sock = socketRef.current;
    if (!sock?.connected) return;
    const now = Date.now();
    if (now - lastTypingEmitAtRef.current < 2000) return;
    lastTypingEmitAtRef.current = now;
    sock.emit('typing:start', {});
  }

  // ── Render: error states ────────────────────────────────────────────
  if (verifyState.kind === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Connecting…
      </div>
    );
  }

  if (verifyState.kind === 'error') {
    return <ChatError {...verifyState} />;
  }

  const data = verifyState.data;
  const isClosed = data.status === 'closed' || data.status === 'expired';

  return (
    <div className="flex h-screen flex-col bg-muted">
      <ChatHeader
        clientName={data.clientName}
        csmName={data.csmName ?? null}
        csmOnline={csmOnline}
      />

      <ConnectionBanner state={conn} />
      {!csmOnline && conn === 'connected' && !isClosed && (
        <div className="bg-amber-50 px-4 py-2 text-center text-xs text-amber-900">
          Your team isn&apos;t online right now — your message will be answered as soon as someone
          is back.
        </div>
      )}

      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 flex-col-reverse overflow-y-auto px-4 py-4">
          <div className="space-y-2">
            {hasMore && (
              <div className="text-center">
                <Button variant="outline" size="sm" onClick={() => void loadMore()}>
                  Load earlier messages
                </Button>
              </div>
            )}
            {messages.map((m) => {
              const fromMe = m.senderType === 'client';
              return (
                <div key={m.id} className={`flex ${fromMe ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={
                      'max-w-[80%] rounded-lg px-3 py-2 text-sm shadow-sm ' +
                      (fromMe
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-foreground')
                    }
                  >
                    <ChatAttachment message={m} sessionJwt={sessionJwtRef.current} />
                    {!getAttachment(m) && (
                      <div className="whitespace-pre-wrap break-words">{m.content}</div>
                    )}
                    <div className="mt-1 text-[10px] opacity-70">
                      {new Date(m.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              );
            })}
            {csmTyping && (
              <div className="flex justify-start">
                <div className="rounded-lg bg-background px-3 py-2 text-sm text-muted-foreground shadow-sm">
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce">·</span>
                    <span className="animate-bounce [animation-delay:150ms]">·</span>
                    <span className="animate-bounce [animation-delay:300ms]">·</span>
                  </span>{' '}
                  typing
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="border-t border-border bg-background p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (e.target.value) emitTyping();
              }}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={isClosed}
              placeholder={isClosed ? 'Conversation closed' : 'Type your message…'}
              className="max-h-32 flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
            />
            <Button onClick={() => void send()} disabled={sending || isClosed || !draft.trim()}>
              <Send className="h-4 w-4" />
              <span className="sr-only">Send</span>
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}

function ChatHeader({
  clientName,
  csmName,
  csmOnline,
}: {
  clientName: string;
  csmName: string | null;
  csmOnline: boolean;
}) {
  return (
    <header className="border-b border-border bg-background px-4 py-3">
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">{csmName ?? 'Customer Success'}</div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={
                'inline-block h-2 w-2 rounded-full ' +
                (csmOnline ? 'bg-green-500' : 'bg-muted-foreground/50')
              }
            />
            {csmOnline ? 'online' : 'offline'}
          </div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>Hello, {clientName}</div>
        </div>
      </div>
    </header>
  );
}

function ConnectionBanner({ state }: { state: ConnState }) {
  if (state === 'connected') return null;
  const labels: Record<ConnState, string> = {
    connecting: 'Connecting…',
    connected: '',
    reconnecting: 'Reconnecting…',
    disconnected: 'Disconnected',
  };
  return (
    <div className="bg-muted px-4 py-1.5 text-center text-[11px] text-muted-foreground">
      {labels[state]}
    </div>
  );
}

function ChatError({
  status,
  code,
  title,
  detail,
}: {
  status: number;
  code: string | null;
  title: string;
  detail: string;
}) {
  // Map well-known codes to friendlier copy.
  let heading = title;
  let body = detail;
  if (code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN') {
    heading = 'Link expired';
    body =
      'This chat link is no longer valid. Please ask your team for a fresh link to continue the conversation.';
  } else if (code === 'DEVICE_MISMATCH') {
    heading = 'Already opened on another device';
    body =
      'For security, each link only works on one device. Please continue on the device where you first opened it, or ask your team for a new link.';
  } else if (code === 'SESSION_CLOSED') {
    heading = 'Conversation closed';
    body = 'This conversation has been closed. Reach out to your team for a new chat link.';
  }

  return (
    <div className="flex h-screen items-center justify-center bg-muted px-4">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-background p-6 text-center shadow-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {status > 0 ? `Error ${status}` : 'Connection error'}
          </div>
          <h1 className="mt-1 text-xl font-semibold">{heading}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
