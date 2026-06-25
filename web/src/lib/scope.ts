// The per-user dashboard mounts at /users/:userId/. The userId comes straight out of the URL
// path at startup (no router needed — the SPA stays on that one page). This module is the single
// place that parses it, so the rest of the app can treat it as a constant.

export interface Scope {
  userId: string;
}

function parseScope(): Scope {
  const m = window.location.pathname.match(/^\/users\/([^/]+)(?:\/|$)/);
  if (!m) {
    throw new Error(
      `Hub dashboard must be mounted under /users/:userId/; got ${window.location.pathname}`,
    );
  }
  return { userId: decodeURIComponent(m[1]!) };
}

let cached: Scope | null = null;

export function useScope(): Scope {
  if (!cached) cached = parseScope();
  return cached;
}
