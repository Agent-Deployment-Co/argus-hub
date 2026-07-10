import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./components/Layout";
import { Activity } from "./routes/Activity";
import { SessionDetail } from "./routes/SessionDetail";
import { SessionEmpty } from "./routes/SessionEmpty";
import { Sessions } from "./routes/Sessions";
import { Tasks } from "./routes/Tasks";
import { Team } from "./routes/Team";
import { Tools } from "./routes/Tools";
import { UserActivity } from "./routes/UserActivity";
import type { SessionsSearch } from "./lib/sessions";
import type { SessionSort } from "./types";

const rootRoute = createRootRoute({ component: Layout });

const VALID_SESSION_SORTS = new Set(["recent", "tokens", "cost"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const sessionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions",
  component: Sessions,
  validateSearch: (search: Record<string, unknown>): SessionsSearch => {
    const sort = str(search.sort);
    return {
      since: str(search.since),
      until: str(search.until),
      source: str(search.source),
      user: str(search.user),
      q: str(search.q),
      sort: sort && VALID_SESSION_SORTS.has(sort) ? (sort as SessionSort) : undefined,
    };
  },
});

function validateSnapshotSearch(search: Record<string, unknown>): { since?: string; until?: string; source?: string } {
  return { since: str(search.since), until: str(search.until), source: str(search.source) };
}

const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Activity,
    validateSearch: validateSnapshotSearch,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tasks",
    component: Tasks,
    validateSearch: (search: Record<string, unknown>): { q?: string; outcome?: string[]; user?: string } => {
      const outcome = Array.isArray(search.outcome)
        ? search.outcome.filter((v): v is string => typeof v === "string")
        : typeof search.outcome === "string"
          ? [search.outcome]
          : [];
      return {
        q: typeof search.q === "string" && search.q.length > 0 ? search.q : undefined,
        outcome: outcome.length > 0 ? outcome : undefined,
        user: typeof search.user === "string" && search.user.length > 0 ? search.user : undefined,
      };
    },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/tools", component: Tools }),
  createRoute({ getParentRoute: () => rootRoute, path: "/users", component: Team }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/users/$userId",
    component: UserActivity,
    validateSearch: validateSnapshotSearch,
  }),
  sessionsRoute.addChildren([
    createRoute({ getParentRoute: () => sessionsRoute, path: "/", component: SessionEmpty }),
    createRoute({ getParentRoute: () => sessionsRoute, path: "$sessionId", component: SessionDetail }),
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
