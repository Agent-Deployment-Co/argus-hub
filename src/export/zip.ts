import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createDeflateRaw } from "node:zlib";

// A tiny, dependency-free *streaming* ZIP archive writer. We already produce a directory of JSONL
// files plus manifest.json / load.sql for the Snowflake export; this streams them into a single
// downloadable .zip without ever holding a whole file (let alone the whole bundle) in memory.
//
// Streaming means we don't know a file's CRC or compressed size until we've read it, so each entry
// uses a data descriptor (general-purpose flag bit 3): the local header carries zeros and the real
// values follow the compressed data. The central directory at the end carries the true values too.
// Only what we need: deflate (method 8), no encryption, no zip64 (the export is well under 4 GB).

export interface ZipFileEntry {
  /** Path within the archive. */
  name: string;
  /** Absolute path to the source file on disk. */
  path: string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Encode a Date as DOS date/time (used by the ZIP headers). Falls back to the 1980 epoch. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

/**
 * Stream a ZIP archive (deflate-compressed) built from a list of on-disk files. Returns a Node
 * Readable that emits the archive bytes; `onClose` runs exactly once when the stream finishes,
 * errors, or is cancelled — use it to clean up the source files.
 */
export function createZipReadable(
  files: readonly ZipFileEntry[],
  options: { now?: Date; onClose?: () => void | Promise<void> } = {},
): Readable {
  return Readable.from(zipChunks(files, options.now ?? new Date(), options.onClose));
}

async function* zipChunks(
  files: readonly ZipFileEntry[],
  now: Date,
  onClose?: () => void | Promise<void>,
): AsyncGenerator<Buffer> {
  const { time, date } = dosDateTime(now);
  const central: Buffer[] = [];
  let offset = 0;

  try {
    for (const file of files) {
      const nameBuf = Buffer.from(file.name, "utf8");
      const localOffset = offset;

      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
      localHeader.writeUInt16LE(20, 4); // version needed
      localHeader.writeUInt16LE(0x0008, 6); // flags: sizes/crc in data descriptor
      localHeader.writeUInt16LE(8, 8); // method: deflate
      localHeader.writeUInt16LE(time, 10);
      localHeader.writeUInt16LE(date, 12);
      // crc-32, compressed size, uncompressed size — all zero; the real values follow the data.
      localHeader.writeUInt16LE(nameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28); // extra field length
      yield localHeader;
      yield nameBuf;

      let crc = 0xffffffff;
      let uncompressedSize = 0;
      let compressedSize = 0;
      const source = createReadStream(file.path);
      source.on("data", (chunk: Buffer) => {
        uncompressedSize += chunk.length;
        for (let i = 0; i < chunk.length; i++) crc = CRC_TABLE[(crc ^ chunk[i]!)! & 0xff]! ^ (crc >>> 8);
      });
      const deflate = createDeflateRaw();
      // pipe() does NOT forward source errors, so wire them through explicitly: without this a read
      // failure would emit an unhandled 'error' on `source` (crashing the process) and leave the
      // deflate consumer below hanging forever.
      source.once("error", (err) => deflate.destroy(err));
      source.pipe(deflate);
      try {
        for await (const chunk of deflate) {
          compressedSize += (chunk as Buffer).length;
          yield chunk as Buffer;
        }
      } finally {
        // Always release the file descriptor — on normal end, on error, and on consumer
        // cancellation (which destroys `deflate` but would otherwise leave `source` open).
        source.destroy();
      }
      crc = (crc ^ 0xffffffff) >>> 0;

      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0); // data descriptor signature
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressedSize, 8);
      descriptor.writeUInt32LE(uncompressedSize, 12);
      yield descriptor;

      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0); // central directory header signature
      centralHeader.writeUInt16LE(20, 4); // version made by
      centralHeader.writeUInt16LE(20, 6); // version needed
      centralHeader.writeUInt16LE(0x0008, 8); // flags
      centralHeader.writeUInt16LE(8, 10); // method: deflate
      centralHeader.writeUInt16LE(time, 12);
      centralHeader.writeUInt16LE(date, 14);
      centralHeader.writeUInt32LE(crc, 16);
      centralHeader.writeUInt32LE(compressedSize, 20);
      centralHeader.writeUInt32LE(uncompressedSize, 24);
      centralHeader.writeUInt16LE(nameBuf.length, 28);
      centralHeader.writeUInt16LE(0, 30); // extra field length
      centralHeader.writeUInt16LE(0, 32); // comment length
      centralHeader.writeUInt16LE(0, 34); // disk number start
      centralHeader.writeUInt16LE(0, 36); // internal attributes
      centralHeader.writeUInt32LE(0, 38); // external attributes
      centralHeader.writeUInt32LE(localOffset, 42); // local header offset
      central.push(centralHeader, nameBuf);

      offset += localHeader.length + nameBuf.length + compressedSize + descriptor.length;
    }

    const centralDir = Buffer.concat(central);
    yield centralDir;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
    end.writeUInt16LE(0, 4); // disk number
    end.writeUInt16LE(0, 6); // disk with central directory
    end.writeUInt16LE(files.length, 8); // entries on this disk
    end.writeUInt16LE(files.length, 10); // total entries
    end.writeUInt32LE(centralDir.length, 12); // central directory size
    end.writeUInt32LE(offset, 16); // central directory offset
    end.writeUInt16LE(0, 20); // comment length
    yield end;
  } finally {
    // Runs on normal completion, error, and consumer cancellation (Readable.from() calls the
    // generator's return()). Best-effort — never let cleanup failure mask the original outcome.
    if (onClose) await Promise.resolve(onClose()).catch(() => undefined);
  }
}
