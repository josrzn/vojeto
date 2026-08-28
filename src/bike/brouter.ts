import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Point } from "../shared/geo.js";
import { parseTrack, type BikeTrack } from "./track.js";

export { parseWays } from "./track.js";
export type { BikeTrack, WaySegment } from "./track.js";

export interface BRouterOptions {
  /** Public instance, or http://localhost:17777/brouter for a self-hosted one. */
  baseUrl: string;
  profile: string;
  cacheDir: string;
  /** Which of BRouter's alternative lines to return, 0 being the primary. */
  alternative?: number;
  /** Pause between live requests. The public instance is donated hardware. */
  throttleMs?: number;
}

let lastRequestAt = 0;

/**
 * Routes a cycling track through the given waypoints.
 *
 * Every response is cached on disk under a hash of the request, so re-running
 * the planner costs nothing and the public server is hit once per route ever.
 */
export async function routeBike(
  waypoints: Point[],
  options: BRouterOptions,
): Promise<BikeTrack> {
  if (waypoints.length < 2) throw new Error("routeBike needs at least two waypoints");

  const lonlats = waypoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join("|");
  const url =
    `${options.baseUrl}?lonlats=${encodeURIComponent(lonlats)}` +
    `&profile=${encodeURIComponent(options.profile)}` +
    `&alternativeidx=${options.alternative ?? 0}&format=geojson`;

  const key = createHash("sha256").update(url).digest("hex").slice(0, 32);
  const cachePath = path.join(options.cacheDir, `${key}.json`);

  const cached = await readFile(cachePath, "utf8").catch(() => null);
  if (cached !== null) return parseTrack(cached);

  const throttleMs = options.throttleMs ?? 1000;
  const wait = lastRequestAt + throttleMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();

  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`BRouter ${response.status}: ${body.slice(0, 200)}`);
  }

  const track = parseTrack(body);
  await mkdir(options.cacheDir, { recursive: true });
  await writeFile(cachePath, body);
  return track;
}
