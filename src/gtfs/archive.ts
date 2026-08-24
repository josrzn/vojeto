import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { open as openZip } from "yauzl-promise";

/**
 * Downloads the feed unless a copy newer than `maxAgeHours` is already on disk.
 * Returns the local path. Writes via a .part file so an interrupted download
 * never leaves a truncated zip that looks valid to the cache check.
 */
export async function downloadFeed(
  url: string,
  destination: string,
  maxAgeHours = 24,
): Promise<string> {
  await mkdir(path.dirname(destination), { recursive: true });

  const existing = await stat(destination).catch(() => null);
  if (existing && Date.now() - existing.mtimeMs < maxAgeHours * 3600_000) {
    console.log(`Using cached feed (${mb(existing.size)}, ${ageHours(existing.mtimeMs)}h old)`);
    return destination;
  }

  console.log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }

  const partial = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(partial));
  await rename(partial, destination);

  const written = await stat(destination);
  console.log(`Downloaded ${mb(written.size)}`);
  return destination;
}

export interface Member {
  stream: Readable;
  close: () => Promise<void>;
}

/**
 * Opens one file of the feed as a stream. `source` may be a .zip or an already
 * extracted directory; inside a zip, members are matched on basename so it
 * works whether or not the feed nests its files in a folder.
 *
 * The caller must fully consume (or destroy) the stream before the returned
 * `close` resolves; the zip keeps a file descriptor open until then.
 */
export async function openMember(source: string, filename: string): Promise<Member | null> {
  if ((await stat(source).catch(() => null))?.isDirectory()) {
    const found = await findInDirectory(source, filename);
    if (!found) return null;
    return { stream: createReadStream(found), close: async () => {} };
  }

  const zip = await openZip(source);
  try {
    for await (const entry of zip) {
      if (path.posix.basename(entry.filename) !== filename) continue;
      const stream = await entry.openReadStream();
      return { stream, close: () => zip.close() };
    }
  } catch (error) {
    await zip.close();
    throw error;
  }
  await zip.close();
  return null;
}

async function findInDirectory(directory: string, filename: string): Promise<string | null> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === filename) return path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findInDirectory(path.join(directory, entry.name), filename);
      if (nested) return nested;
    }
  }
  return null;
}

export async function listMembers(zipPath: string): Promise<string[]> {
  const zip = await openZip(zipPath);
  const names: string[] = [];
  try {
    for await (const entry of zip) names.push(entry.filename);
  } finally {
    await zip.close();
  }
  return names;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const ageHours = (ms: number) => ((Date.now() - ms) / 3600_000).toFixed(1);
