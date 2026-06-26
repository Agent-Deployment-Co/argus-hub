#!/usr/bin/env bun
// Bump the version across all places that track it:
//   - package.json                               (npm package)
//
// Usage: bun run scripts/bump-version.ts <new-version>
//   e.g. bun run scripts/bump-version.ts 0.2.0
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: bun run scripts/bump-version.ts <major.minor.patch>");
  process.exit(1);
}

const root = new URL("..", import.meta.url).pathname;

function updateJson(relPath: string, update: (obj: Record<string, unknown>) => void) {
  const abs = join(root, relPath);
  const obj = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
  update(obj);
  writeFileSync(abs, JSON.stringify(obj, null, 2) + "\n");
  console.log(`  ${relPath}  →  ${version}`);
}

console.log(`Bumping to ${version}:`);
updateJson("package.json", (p) => { p.version = version; });
