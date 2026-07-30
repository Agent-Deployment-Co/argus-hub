const argv = new Set(process.argv.slice(2));

// Boolean serve flags this dev script knows how to toggle, either via `bun run dev --flag` or
// the matching env var (see src/cli.ts's `serve` command for the canonical list).
const SERVE_FLAGS = ["--read-only", "--no-password", "--no-mcp", "--no-export"] as const;
const ENV_VARS: Record<(typeof SERVE_FLAGS)[number], string> = {
  "--read-only": "HUB_READ_ONLY",
  "--no-password": "HUB_NO_PASSWORD",
  "--no-mcp": "HUB_NO_MCP",
  "--no-export": "HUB_NO_EXPORT",
};
const activeFlags = SERVE_FLAGS.filter((flag) => argv.has(flag) || process.env[ENV_VARS[flag]] === "true");

const port = process.env.HUB_PORT ?? "4343";

function command(args: string[]) {
  return Bun.spawn({
    cmd: args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

// Build once before starting the server so the dashboard is available immediately.
const initialBuild = command(["bun", "run", "build:web"]);
if (await initialBuild.exited) process.exitCode = 1;
if (process.exitCode) process.exit();

const modes = activeFlags.map((flag) => flag.slice(2)).join(", ");
process.stdout.write(`Hub → http://localhost:${port}/${modes ? ` (${modes})` : ""}\n`);

const server = command([
  "bun",
  "--watch",
  "--no-clear-screen",
  "src/cli.ts",
  "serve",
  "--port",
  port,
  ...activeFlags,
]);
const webBuilder = command(["bun", "run", "build:web", "--", "--watch"]);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.kill();
  webBuilder.kill();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);

const exited = await Promise.race([server.exited, webBuilder.exited]);
stop();
process.exitCode = exited === 0 ? 0 : 1;
