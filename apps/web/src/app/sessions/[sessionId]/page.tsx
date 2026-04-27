'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Paperclip, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, API_URL, ApiError, getAccessToken, onAccessTokenChange } from '@/lib/api';
import { connectAsCsm, type ChatSocket } from '@/lib/socket';
import { useAuth } from '@/lib/auth-store';
import type { ListMessagesResponse, Message, SessionDetail } from '@csm-chat/shared';

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

function hasAttachment(m: Message): boolean {
  return getAttachment(m) !== null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(mime: string): string {
  if (mime === 'application/pdf') return '📕';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.includes('word') || mime.includes('msword')) return '📄';
  return '📎';
}

function AttachmentBlock({
  message,
  accessToken,
}: {
  message: Message;
  accessToken: string | null;
}) {
  const att = getAttachment(message);
  const url = att ? `${API_URL}/v1/attachments/${att.id}` : null;
  const isImage = att?.mimeType.startsWith('image/') ?? false;

  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState(false);

  // Auth-fetch images so they render inline. Bytes are auth-gated, so a
  // plain <img src> would never work with our Bearer-token endpoint.
  useEffect(() => {
    if (!isImage || !url || !accessToken) return;
    let cancelled = false;
    let blobUrl: string | null = null;
    void (async () => {
      try {
        const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
        if (!res.ok) {
          if (!cancelled) setImgErr(true);
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        blobUrl = URL.createObjectURL(blob);
        setImgUrl(blobUrl);
      } catch {
        if (!cancelled) setImgErr(true);
      }
    })();
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [isImage, url, accessToken]);

  async function openInTab(): Promise<void> {
    if (!url) return;
    try {
      const res = await fetch(url, {
        headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
      });
      if (!res.ok) {
        toast.error('Could not open attachment');
        return;
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch {
      toast.error('Could not open attachment');
    }
  }

  if (!att) return null;

  if (isImage) {
    return (
      <button
        type="button"
        onClick={() => void openInTab()}
        className="block max-w-full overflow-hidden rounded-md"
      >
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={att.filename}
            className="max-h-72 w-auto max-w-full rounded-md object-contain"
          />
        ) : imgErr ? (
          <div className="rounded-md bg-background/20 px-3 py-2 text-xs">
            Could not load image
          </div>
        ) : (
          <div className="flex h-32 w-48 items-center justify-center rounded-md bg-background/20 text-xs opacity-70">
            Loading image…
          </div>
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void openInTab()}
      className="flex w-full max-w-xs items-center gap-2 rounded-md border border-border/40 bg-background/10 px-3 py-2 text-left hover:bg-background/20"
    >
      <span className="text-2xl leading-none">{fileIcon(att.mimeType)}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{att.filename}</div>
        <div className="text-[11px] opacity-70">
          {formatBytes(att.sizeBytes)} · click to open
        </div>
      </div>
    </button>
  );
}

export default function SessionDetailPage() {
  const router = useRouter();
  const { user } = useAuth();
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [oldestCreatedAt, setOldestCreatedAt] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [csmOnline, setCsmOnline] = useState(true);
  const [clientTyping, setClientTyping] = useState(false);
  const [closing, setClosing] = useState(false);
  const [uploading, setUploading] = useState(false);

  const socketRef = useRef<ChatSocket | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingEmitAtRef = useRef<number>(0);

  const loadDetail = useCallback(async () => {
    try {
      const d = await api<SessionDetail>(`/v1/sessions/${sessionId}`, { auth: true });
      setDetail(d);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
    }
  }, [sessionId]);

  const loadInitialMessages = useCallback(async () => {
    try {
      const data = await api<ListMessagesResponse>(
        `/v1/sessions/${sessionId}/messages?limit=${PAGE_SIZE}`,
        { auth: true },
      );
      setMessages(data.items);
      setHasMore(data.hasMore);
      setOldestCreatedAt(data.oldestCreatedAt);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
    }
  }, [sessionId]);

  async function loadMore(): Promise<void> {
    if (!oldestCreatedAt) return;
    try {
      const data = await api<ListMessagesResponse>(
        `/v1/sessions/${sessionId}/messages?limit=${PAGE_SIZE}&before=${encodeURIComponent(oldestCreatedAt)}`,
        { auth: true },
      );
      setMessages((prev) => [...data.items, ...prev]);
      setHasMore(data.hasMore);
      setOldestCreatedAt(data.oldestCreatedAt ?? oldestCreatedAt);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
    }
  }

  useEffect(() => {
    void loadDetail();
    void loadInitialMessages();
  }, [loadDetail, loadInitialMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Establish/refresh socket as our access token rotates.
  useEffect(() => {
    function open(token: string | null): void {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      if (!token) return;
      const sock = connectAsCsm(token);
      socketRef.current = sock;

      // Join this session's broadcast room. The server auto-joins CSMs only
      // to rooms for sessions where assignedCsmId === userId; sessions
      // created with no assignedCsmId aren't in that set, so without this
      // explicit join the CSM would receive no message:new events at all.
      sock.on('connect', () => {
        sock.emit('session:join', { sessionId }, (resp: { ok: boolean }) => {
          if (!resp?.ok) {
            // Silent — the user will still see optimistic-rendered own
            // messages via the ack path below, just not the client's replies.
          }
        });
      });

      sock.on('message:new', (msg: Message) => {
        if (msg.sessionId !== sessionId) return;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        // Any new message from the client ends their typing indicator.
        if (msg.senderType === 'client') setClientTyping(false);
      });
      sock.on('presence:csm', (info: { online: boolean }) => {
        // For the dashboard, "presence:csm" tracks whether ANY CSM is connected to
        // this session. We don't show our own presence to ourselves.
        setCsmOnline(info.online);
      });
      sock.on('typing:other', (info: { from: string; sessionId: string }) => {
        if (info.from !== 'client' || info.sessionId !== sessionId) return;
        setClientTyping(true);
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => setClientTyping(false), 4000);
      });
      sock.on('connect_error', (err) => {
        toast.error(`WS connect: ${err.message}`);
      });
    }

    open(getAccessToken());
    const unsubscribe = onAccessTokenChange((t) => open(t));
    return () => {
      unsubscribe();
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [sessionId]);

  async function send(): Promise<void> {
    const content = draft.trim();
    if (!content) return;
    setSending(true);
    setDraft('');
    const clientMessageId = crypto.randomUUID();
    const sock = socketRef.current;
    try {
      if (sock?.connected) {
        const ack = await new Promise<{ ok: boolean; message?: Message; error?: string }>(
          (resolve) =>
            sock.emit(
              'message:send',
              { sessionId, content, clientMessageId },
              (resp: { ok: boolean; message?: Message; error?: string }) => resolve(resp),
            ),
        );
        if (ack.ok && ack.message) {
          // Optimistically render our own message — de-duped by id so that
          // if the broadcast also arrives later, it doesn't duplicate.
          const own = ack.message;
          setMessages((prev) => (prev.some((m) => m.id === own.id) ? prev : [...prev, own]));
        } else if (!ack.ok) {
          toast.error(`Send failed: ${ack.error ?? 'unknown'}`);
        }
      } else {
        // REST fallback — same optimistic merge.
        const own = await api<Message>(`/v1/sessions/${sessionId}/messages`, {
          method: 'POST',
          auth: true,
          json: { content, clientMessageId },
        });
        setMessages((prev) => (prev.some((m) => m.id === own.id) ? prev : [...prev, own]));
      }
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
    } finally {
      setSending(false);
    }
  }

  async function handleClose(): Promise<void> {
    if (!confirm('Close this session? The client will not be able to send further messages.'))
      return;
    setClosing(true);
    try {
      await api(`/v1/sessions/${sessionId}/close`, { method: 'POST', auth: true, json: {} });
      toast.success('Session closed');
      router.replace('/sessions');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
    } finally {
      setClosing(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  function emitTyping(): void {
    const sock = socketRef.current;
    if (!sock?.connected) return;
    const now = Date.now();
    if (now - lastTypingEmitAtRef.current < 2000) return;
    lastTypingEmitAtRef.current = now;
    sock.emit('typing:start', { sessionId });
  }

  async function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so picking the same file again still fires onChange
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error('File too large (10 MB max)');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const own = await api<Message>(`/v1/sessions/${sessionId}/attachments`, {
        method: 'POST',
        auth: true,
        body: fd,
      });
      setMessages((prev) => (prev.some((m) => m.id === own.id) ? prev : [...prev, own]));
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error('Upload failed');
    } finally {
      setUploading(false);
    }
  }

  if (!user) return null;

  const isClosed = detail?.status === 'closed' || detail?.status === 'expired';

  return (
    <div className="flex h-screen flex-col bg-muted">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <Link href="/sessions" aria-label="Back">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <div>
              <div className="text-sm font-semibold">
                {detail?.client.name ?? 'Loading…'}
                {detail?.client.company ? ` · ${detail.client.company}` : ''}
              </div>
              <div className="text-xs text-muted-foreground">
                {detail?.client.email}
                {detail?.status ? ` · ${detail.status}` : ''}
                {' · '}
                <span className={csmOnline ? 'text-green-600' : 'text-muted-foreground'}>
                  {csmOnline ? 'connected' : 'disconnected'}
                </span>
              </div>
            </div>
          </div>
          {!isClosed && (
            <Button variant="destructive" size="sm" onClick={handleClose} disabled={closing}>
              <X className="h-4 w-4" />
              Close
            </Button>
          )}
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden">
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
              const mine = m.senderType === 'csm' && m.senderId === user.id;
              const isCsm = m.senderType === 'csm';
              return (
                <div
                  key={m.id}
                  className={`flex ${mine ? 'justify-end' : isCsm ? 'justify-end' : 'justify-start'}`}
                >
                  <div
                    className={
                      'max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm ' +
                      (isCsm
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-background text-foreground')
                    }
                  >
                    <AttachmentBlock message={m} accessToken={getAccessToken()} />
                    {!hasAttachment(m) && (
                      <div className="whitespace-pre-wrap break-words">{m.content}</div>
                    )}
                    <div className="mt-1 text-[10px] opacity-70">
                      {new Date(m.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              );
            })}
            {clientTyping && (
              <div className="flex justify-start">
                <div className="rounded-lg bg-background px-3 py-2 shadow-sm">
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground" />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="border-t border-border bg-background p-3">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => void handleFilePicked(e)}
          />
          <div className="flex items-end gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => fileInputRef.current?.click()}
              disabled={isClosed || uploading}
              aria-label="Attach file"
              title="Attach image, PDF, or document (10 MB max)"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (e.target.value) emitTyping();
              }}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={isClosed}
              placeholder={isClosed ? 'Session closed' : 'Type a message…'}
              className="flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
            />
            <Button onClick={() => void send()} disabled={sending || isClosed || !draft.trim()}>
              <Send className="h-4 w-4" />
              <span className="hidden sm:inline">Send</span>
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
