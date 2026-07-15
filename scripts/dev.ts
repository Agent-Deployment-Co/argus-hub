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

process.stdout.write(`Hub → http://localhost:${port}/\n`);

const server = command([
  "bun",
  "--watch",
  "--no-clear-screen",
  "src/cli.ts",
  "serve",
  "--port",
  port,
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
