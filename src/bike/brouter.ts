import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Point } from "../shared/geo.js";
import { parseTags } from "./surface.js";

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

export interface BikeTrack {
  /** [lon, lat, altitude] vertices. */
  coordinates: number[][];
  metres: number;
  ascentMetres: number;
  /** BRouter's own time estimate for the profile, in seconds. */
  estimatedSeconds: number;
  /**
   * What each stretch of the route is made of, in order along it.
   *
   * Empty when the response carried no `messages` table — an older or
   * differently configured server. Everything downstream treats that as
   * "surface unrecorded" rather than guessing, so a server that does not
   * report tags still produces a plan, just one that says less.
   */
  ways: WaySegment[];
}

/** One stretch of road, as BRouter's `messages` table describes it. */
export interface WaySegment {
  /** Length of this stretch, in metres. */
  metres: number;
  /** The OSM tags on the way, plus whatever BRouter adds of its own. */
  tags: Record<string, string>;
}

interface BRouterFeature {
  properties?: Record<string, unknown>;
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
  const text = (key: string) => String(properties[key] ?? "");
  return {
    coordinates,
    metres: Number(text("track-length")),
    // "filtered ascend" ignores the noise in the elevation model; it is the
    // number that matches what a bike computer reports.
    ascentMetres: Number(text("filtered ascend")),
    estimatedSeconds: Number(text("total-time")),
    ways: parseWays(properties["messages"]),
  };
}

/**
 * The `messages` table, as a list of stretches with their tags.
 *
 * BRouter ships it as a table of strings whose first row is the header, so the
 * columns are found by name rather than by position — the layout has changed
 * before, and reading `row[9]` would fail silently and invisibly if it changed
 * again, timing every route as though it were paved.
 *
 * `Distance` is the length of that one stretch, not a running total.
 */
export function parseWays(messages: unknown): WaySegment[] {
  if (!Array.isArray(messages) || messages.length < 2) return [];
  const header = messages[0];
  if (!Array.isArray(header)) return [];

  const distanceAt = header.indexOf("Distance");
  const tagsAt = header.indexOf("WayTags");
  if (distanceAt < 0 || tagsAt < 0) return [];

  const ways: WaySegment[] = [];
  for (let i = 1; i < messages.length; i++) {
    const row = messages[i];
    if (!Array.isArray(row)) continue;
    const metres = Number(row[distanceAt]);
    if (!Number.isFinite(metres) || metres <= 0) continue;
    ways.push({ metres, tags: parseTags(String(row[tagsAt] ?? "")) });
  }
  return ways;
}
