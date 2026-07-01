import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The hub web SPA is a client-routed app (side nav: team Activity, per-user pages under
// /users/$userId) served by the Hono server at a fixed root, so asset URLs are absolute
// (base: "/") rather than relative — relative URLs would break at nested route depths like
// /users/alice. Built output lands in hub/dist/web; the dev server proxies /api to the hub
// Hono server (default port 4343).
export default defineConfig({
  root: __dirname,
  base: "/",
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": `http://localhost:${process.env.HUB_PORT || 4343}`,
    },
  },
});
