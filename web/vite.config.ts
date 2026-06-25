import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The hub web SPA is mounted by the Hono server under /orgs/:orgId/users/:userId/, so the build
// uses base: "./" — relative asset URLs work under any URL prefix. Built output lands in
// hub/dist/web; the dev server proxies /api to the hub Hono server (default port 4343).
export default defineConfig({
  root: __dirname,
  base: "./",
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
