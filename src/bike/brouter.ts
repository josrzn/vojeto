import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Point } from "../shared/geo.js";

export interface BRouterOptions {
  /** Public instance, or http://localhost:17777/brouter for a self-hosted one. */
  baseUrl: string;
  profile: string;
  cacheDir: string;
  /** Pause between live requests. The public instance is donated hardware. */
  throttleMs?: number;
}

export interface BikeTrack {
  /** [lon, lat, altitude] vertices. */
  coordinates: number[][];
  metres: number;
  ascentMetres: number;
  /** BRouter's own time estimate for the profile, in seconds. */
  estimatedSeconds: number;
}

interface BRouterFeature {
  properties?: Record<string, string>;
  geometry?: { coordinates?: number[][] };
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
    `&profile=${encodeURIComponent(options.profile)}&alternativeidx=0&format=geojson`;

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

function parseTrack(body: string): BikeTrack {
  let parsed: { features?: BRouterFeature[] };
  try {
    parsed = JSON.parse(body) as { features?: BRouterFeature[] };
  } catch {
    // BRouter reports "no route" and profile errors as plain text, not JSON.
    throw new Error(`BRouter returned a non-JSON response: ${body.slice(0, 200)}`);
  }

  const feature = parsed.features?.[0];
  const coordinates = feature?.geometry?.coordinates;
  if (!feature || !coordinates?.length) throw new Error("BRouter returned no route");

  const properties = feature.properties ?? {};
  return {
    coordinates,
    metres: Number(properties["track-length"] ?? 0),
    // "filtered ascend" ignores the noise in the elevation model; it is the
    // number that matches what a bike computer reports.
    ascentMetres: Number(properties["filtered ascend"] ?? 0),
    estimatedSeconds: Number(properties["total-time"] ?? 0),
  };
}
