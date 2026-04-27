'use client';

import { useState } from 'react';
import { Copy, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, ApiError } from '@/lib/api';
import type { CreateSessionResponse } from '@csm-chat/shared';

interface Props {
  onCreated?(): void;
}

export function CreateSessionDialog({ onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateSessionResponse | null>(null);

  const [clientEmail, setClientEmail] = useState('');
  const [clientName, setClientName] = useState('');
  const [clientCompany, setClientCompany] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(7);

  function reset(): void {
    setClientEmail('');
    setClientName('');
    setClientCompany('');
    setExpiresInDays(7);
    setResult(null);
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      const body = await api<CreateSessionResponse>('/v1/sessions', {
        method: 'POST',
        auth: true,
        json: {
          clientEmail,
          clientName,
          clientCompany: clientCompany || undefined,
          expiresInDays,
        },
      });
      setResult(body);
      onCreated?.();
    } catch (err) {
      if (err instanceof ApiError) {
        toast.error(err.problem?.detail ?? 'Failed to create session');
      } else {
        toast.error('Failed to create session');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy(): Promise<void> {
    if (!result) return;
    await navigator.clipboard.writeText(result.chatUrl);
    toast.success('Chat URL copied');
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" />
          New session
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{result ? 'Session created' : 'Create a chat session'}</DialogTitle>
          <DialogDescription>
            {result
              ? 'Send this URL to the client. The link is single-device-bound on first use.'
              : 'A new session generates a secure URL you can share with the client.'}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Chat URL</Label>
              <div className="flex gap-2">
                <Input readOnly value={result.chatUrl} />
                <Button type="button" variant="outline" size="icon" onClick={handleCopy}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Status</span>
                <div>{result.session.status}</div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground">Expires</span>
                <div>{new Date(result.expiresAt).toLocaleString()}</div>
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cs-email">Client email</Label>
              <Input
                id="cs-email"
                type="email"
                required
                value={clientEmail}
                onChange={(e) => setClientEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cs-name">Client name</Label>
              <Input
                id="cs-name"
                required
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cs-company">Company (optional)</Label>
              <Input
                id="cs-company"
                value={clientCompany}
                onChange={(e) => setClientCompany(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cs-days">Expires in (days)</Label>
              <Input
                id="cs-days"
                type="number"
                min={1}
                max={30}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(Number(e.target.value))}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Creating…' : 'Create session'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
