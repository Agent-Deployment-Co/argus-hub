// Server capability flags for the SPA, read from GET /healthz (the one route that's always
// mounted, even in read-only mode — see createHubApp in src/api/serve.ts).
// - readOnly: consumers hide edit affordances (settings, groups, labels, task-labels) rather
//   than rendering a button that hits a route the server dropped.
// - noPassword: the server was started with --no-password, so there's no session to sign out
//   of — consumers hide the sign-out affordance.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface Capabilities {
  readOnly: boolean;
  noPassword: boolean;
}

const Ctx = createContext<Capabilities>({ readOnly: false, noPassword: false });

export function ReadOnlyProvider({ children }: { children: ReactNode }) {
  const [caps, setCaps] = useState<Capabilities>({ readOnly: false, noPassword: false });

  useEffect(() => {
    let cancelled = false;
    fetch("/healthz")
      .then((res) => res.json())
      .then((body: { readOnly?: boolean; noPassword?: boolean }) => {
        if (!cancelled) setCaps({ readOnly: Boolean(body.readOnly), noPassword: Boolean(body.noPassword) });
      })
      .catch(() => {
        // Offline or malformed — stay in the (safer) affordances-shown default rather than blocking render.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <Ctx.Provider value={caps}>{children}</Ctx.Provider>;
}

/** Whether this server is running in read-only mode. Defaults to false until /healthz answers,
 *  so on a normal (non-read-only) install there's no flash of hidden-then-shown affordances. */
export const useReadOnly = () => useContext(Ctx).readOnly;

/** Whether this server was started with --no-password (no login, no session to sign out of). */
export const useNoPassword = () => useContext(Ctx).noPassword;
