import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Layout } from "./components/Layout";
import { Activity } from "./routes/Activity";
import { Team } from "./routes/Team";
import { UserActivity } from "./routes/UserActivity";

const rootRoute = createRootRoute({ component: Layout });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: Activity }),
  createRoute({ getParentRoute: () => rootRoute, path: "/users", component: Team }),
  createRoute({ getParentRoute: () => rootRoute, path: "/users/$userId", component: UserActivity }),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
