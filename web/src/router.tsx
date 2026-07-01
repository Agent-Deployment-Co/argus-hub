import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./components/Layout";
import { Activity } from "./routes/Activity";
import { Tasks } from "./routes/Tasks";
import { Team } from "./routes/Team";
import { Tools } from "./routes/Tools";
import { UserActivity } from "./routes/UserActivity";

const rootRoute = createRootRoute({ component: Layout });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Activity }),
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
  createRoute({ getParentRoute: () => rootRoute, path: "/users/$userId", component: UserActivity }),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
