import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { openHubStore } from "../src/store/hub-store.ts";
import { SNOWFLAKE_EXPORT_TABLES, openSnowflakeZipStream } from "../src/export/snowflake.ts";
import { createZipReadable } from "../src/export/zip.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "argus-zip-test-"));
  tempDirs.push(dir);
  return dir;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Read a Node Readable (wrapped as a web stream, as the server does) to completion. */
function collect(readable: Readable): Promise<Buffer> {
  return collectStream(Readable.toWeb(readable) as unknown as ReadableStream<Uint8Array>);
}

/**
 * Read an archive via its central directory — the authoritative index — so it works regardless of
 * whether entries use data descriptors (which zero the sizes in the local header).
 */
function readZip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.length - 22; // no archive comment
  if (buf.readUInt32LE(eocd) !== 0x06054b50) throw new Error("no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // central directory offset

  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error("bad central directory header");
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);

    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

describe("createZipReadable", () => {
  test("round-trips file contents through streamed deflate", async () => {
    const dir = tempDir();
    const hello = Buffer.from("hello world\n".repeat(1000), "utf8");
    const other = Buffer.from(JSON.stringify({ a: 1, b: [2, 3] }), "utf8");
    writeFileSync(join(dir, "a.txt"), hello);
    writeFileSync(join(dir, "b.json"), other);

    const zip = await collect(createZipReadable([
      { name: "a.txt", path: join(dir, "a.txt") },
      { name: "nested/b.json", path: join(dir, "b.json") },
    ]));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50); // starts with a local file header

    const entries = readZip(zip);
    expect([...entries.keys()]).toEqual(["a.txt", "nested/b.json"]);
    expect(entries.get("a.txt")!.equals(hello)).toBe(true);
    expect(entries.get("nested/b.json")!.equals(other)).toBe(true);
  });

  test("handles empty files and produces a valid empty archive", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "empty.txt"), "");
    const withEmpty = await collect(createZipReadable([{ name: "empty.txt", path: join(dir, "empty.txt") }]));
    expect(readZip(withEmpty).get("empty.txt")!.length).toBe(0);

    const empty = await collect(createZipReadable([]));
    expect(readZip(empty).size).toBe(0);
    expect(empty.readUInt32LE(0)).toBe(0x06054b50); // just the end-of-central-directory record
  });

  test("runs onClose exactly once after the stream is fully read", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "hi");
    let closed = 0;
    await collect(createZipReadable([{ name: "a.txt", path: join(dir, "a.txt") }], { onClose: () => { closed++; } }));
    expect(closed).toBe(1);
  });
});

describe("openSnowflakeZipStream", () => {
  test("streams every reporting table plus manifest.json and load.sql, then cleans up its temp dir", async () => {
    const dataDir = join(tempDir(), "data");
    const store = await openHubStore(dataDir, 1_000);
    await store.close();

    const exportDirsBefore = readdirSync(tmpdir()).filter((n) => n.startsWith("argus-hub-export-"));

    const { stream, manifest } = await openSnowflakeZipStream({
      dbPath: join(dataDir, "hub.db"),
      target: { database: "ANALYTICS", schema: "ARGUS_HUB" },
      now: new Date("2026-07-21T12:00:00.000Z"),
    });

    const entries = readZip(await collectStream(stream));
    for (const table of SNOWFLAKE_EXPORT_TABLES) {
      expect(entries.has(`${table.name}.jsonl`)).toBe(true);
    }
    expect(entries.has("manifest.json")).toBe(true);
    expect(entries.has("load.sql")).toBe(true);
    expect(entries.has("api_keys.jsonl")).toBe(false);

    expect(JSON.parse(entries.get("manifest.json")!.toString("utf8"))).toEqual(manifest as unknown as Record<string, unknown>);
    expect(entries.get("load.sql")!.toString("utf8")).toContain('"ANALYTICS"."ARGUS_HUB"');

    // Draining the stream removes the temp directory it created — no leak beyond what was there.
    const exportDirsAfter = readdirSync(tmpdir()).filter((n) => n.startsWith("argus-hub-export-"));
    expect(exportDirsAfter.length).toBeLessThanOrEqual(exportDirsBefore.length);
  });

  test("cleans up the temp dir when the snapshot fails", async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("argus-hub-export-"));
    await expect(openSnowflakeZipStream({ dbPath: join(tempDir(), "does-not-exist.db") })).rejects.toThrow();
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("argus-hub-export-"));
    expect(after.length).toBeLessThanOrEqual(before.length);
  });
});
