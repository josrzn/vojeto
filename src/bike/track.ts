import { parseTags } from "./surface.js";

/**
 * A routed line, and how to read one out of a BRouter response.
 *
 * Apart from the client that fetches it because the browser needs this half and
 * not the other: parsing a response involves no filesystem, no cache and no
 * throttle, and the page routes over the network with none of those.
 */
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


export function parseTrack(body: string): BikeTrack {
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
