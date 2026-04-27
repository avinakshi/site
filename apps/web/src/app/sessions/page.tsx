'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { CreateSessionDialog } from '@/components/create-session-dialog';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth-store';
import type { ListSessionsResponse, Session, SessionStatus } from '@csm-chat/shared';

const STATUS_CHOICES: SessionStatus[] = ['pending', 'active', 'csm_handling', 'closed'];

export default function SessionsPage() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<Set<SessionStatus>>(
    new Set(['pending', 'active', 'csm_handling']),
  );
  const [mineOnly, setMineOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  const fetchSessions = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', '20');
      for (const s of statusFilter) params.append('status', s);
      if (mineOnly) params.set('assignedCsmId', user.id);
      const data = await api<ListSessionsResponse>(`/v1/sessions?${params}`, { auth: true });
      setSessions(data.items);
      setHasMore(data.hasMore);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [user, page, statusFilter, mineOnly]);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  function toggleStatus(status: SessionStatus): void {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
    setPage(1);
  }

  async function handleLogout(): Promise<void> {
    await logout();
    router.replace('/login');
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-muted">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div>
            <h1 className="text-lg font-semibold">Sessions</h1>
            <p className="text-xs text-muted-foreground">
              {user.name} · {user.role}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <CreateSessionDialog onCreated={() => void fetchSessions()} />
            <Button variant="ghost" size="icon" onClick={handleLogout} aria-label="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1.5">
            {STATUS_CHOICES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => toggleStatus(s)}
                className={
                  'rounded-full border px-3 py-1 text-xs ' +
                  (statusFilter.has(s)
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-muted-foreground')
                }
              >
                {s}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={mineOnly}
              onChange={(e) => {
                setMineOnly(e.target.checked);
                setPage(1);
              }}
            />
            Mine only
          </label>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-background">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Client</th>
                <th className="px-4 py-2">Status</th>
                <th className="hidden px-4 py-2 sm:table-cell">Last message</th>
                <th className="hidden px-4 py-2 md:table-cell">Created</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : sessions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                    No sessions match the current filters.
                  </td>
                </tr>
              ) : (
                sessions.map((s) => (
                  <tr key={s.id} className="border-t border-border hover:bg-muted/50">
                    <td className="px-4 py-3 font-mono text-xs">{s.clientId.slice(0, 8)}</td>
                    <td className="px-4 py-3">
                      <span className="rounded bg-muted px-2 py-0.5 text-xs">{s.status}</span>
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-muted-foreground sm:table-cell">
                      {s.lastMessageAt ? new Date(s.lastMessageAt).toLocaleString() : '—'}
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-muted-foreground md:table-cell">
                      {new Date(s.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/sessions/${s.id}`}>
                        <Button variant="outline" size="sm">
                          Open
                        </Button>
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </Button>
          <span>Page {page}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </main>
    </div>
  );
}
