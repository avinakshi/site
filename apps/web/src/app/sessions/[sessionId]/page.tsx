'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, ApiError, getAccessToken, onAccessTokenChange } from '@/lib/api';
import { connectAsCsm, type ChatSocket } from '@/lib/socket';
import { useAuth } from '@/lib/auth-store';
import type { ListMessagesResponse, Message, SessionDetail } from '@csm-chat/shared';

const PAGE_SIZE = 50;

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
  const [closing, setClosing] = useState(false);

  const socketRef = useRef<ChatSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

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

      sock.on('message:new', (msg: Message) => {
        if (msg.sessionId !== sessionId) return;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      });
      sock.on('presence:csm', (info: { online: boolean }) => {
        // For the dashboard, "presence:csm" tracks whether ANY CSM is connected to
        // this session. We don't show our own presence to ourselves.
        setCsmOnline(info.online);
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
        if (!ack.ok) {
          toast.error(`Send failed: ${ack.error ?? 'unknown'}`);
        }
      } else {
        // REST fallback
        await api<Message>(`/v1/sessions/${sessionId}/messages`, {
          method: 'POST',
          auth: true,
          json: { content, clientMessageId },
        });
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
                    <div className="whitespace-pre-wrap break-words">{m.content}</div>
                    <div className="mt-1 text-[10px] opacity-70">
                      {new Date(m.createdAt).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="border-t border-border bg-background p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
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
