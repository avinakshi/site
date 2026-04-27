'use client';

/**
 * Tiny in-tab notification helper. No browser-permission prompts —
 * works in the open tab using the title bar and a short tone synthesized
 * via WebAudio. Designed to mirror what messaging apps do client-side
 * before any push integration: catch the user's eye when they're in
 * another tab without nagging for permission.
 */

let audioCtx: AudioContext | null = null;
function getAudio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (audioCtx) return audioCtx;
  const Ctx =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  audioCtx = new Ctx();
  return audioCtx;
}

/** Play a short two-note ding. Safe to call rapidly — coalesces. */
let lastPingAt = 0;
export function playPing(): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  if (now - lastPingAt < 800) return; // de-dupe rapid bursts
  lastPingAt = now;

  const ctx = getAudio();
  if (!ctx) return;
  // Resume on first interaction (autoplay policy).
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);

  const t0 = ctx.currentTime;
  const tones = [
    { freq: 660, start: 0.0, dur: 0.12 },
    { freq: 880, start: 0.1, dur: 0.16 },
  ];
  for (const tone of tones) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = tone.freq;
    gain.gain.setValueAtTime(0.0001, t0 + tone.start);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + tone.start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.start + tone.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + tone.start);
    osc.stop(t0 + tone.start + tone.dur + 0.02);
  }
}

/**
 * Manage the document title with an unread counter shown only while
 * the tab is hidden. Returns a teardown that restores the original
 * title and removes listeners.
 */
export function attachUnreadTitle(): {
  bump: () => void;
  reset: () => void;
  destroy: () => void;
} {
  if (typeof document === 'undefined') {
    return { bump: () => undefined, reset: () => undefined, destroy: () => undefined };
  }
  const baseTitle = document.title;
  let unread = 0;

  function paint(): void {
    if (unread > 0 && document.hidden) {
      document.title = `(${unread}) ${baseTitle}`;
    } else {
      document.title = baseTitle;
    }
  }

  function onVisible(): void {
    if (!document.hidden) {
      unread = 0;
      paint();
    }
  }

  document.addEventListener('visibilitychange', onVisible);

  return {
    bump() {
      if (!document.hidden) return; // foreground tab: no need
      unread += 1;
      paint();
    },
    reset() {
      unread = 0;
      paint();
    },
    destroy() {
      document.removeEventListener('visibilitychange', onVisible);
      document.title = baseTitle;
    },
  };
}
