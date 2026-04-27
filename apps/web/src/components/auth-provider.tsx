'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-store';

// '/' is intentionally NOT public — visiting it must redirect away
// (to /sessions when authed, /login otherwise). app/page.tsx is a
// bare `null` and would render as a blank screen if we let it fall
// through this guard.
const PUBLIC_PATHS = new Set(['/login']);

/**
 * Wraps the app: bootstraps auth via the csm_refresh cookie and
 * redirects to /login when an authed page is accessed unauthenticated.
 * Client-only — chat/* pages have their own token flow and live outside
 * this guard.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, initializing, bootstrap } = useAuth();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (initializing) return;
    const isPublic = PUBLIC_PATHS.has(pathname) || pathname.startsWith('/c/');
    if (!user && !isPublic) {
      router.replace('/login');
    } else if (user && pathname === '/login') {
      router.replace('/sessions');
    } else if (user && pathname === '/') {
      router.replace('/sessions');
    }
  }, [user, initializing, pathname, router]);

  if (initializing) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return <>{children}</>;
}
