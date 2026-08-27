/**
 * What you are riding on, from the OSM tags BRouter reports for each way.
 *
 * Three classes rather than a dozen. The question this answers is the one a
 * rider actually asks — "is this the gravel route or the road route" — and a
 * finer split would be more numbers to tune than anyone can hold an opinion
 * about. Adding a class later costs one entry in the config and one in the
 * ladder below, because the speed model is keyed by name.
 */
export type Surface = "paved" | "unpaved" | "unknown";

export const SURFACES: readonly Surface[] = ["paved", "unpaved", "unknown"];

/**
 * BRouter's WayTags column: space-separated `key=value` pairs.
 *
 * Not all of them are OSM tags — `reversedirection=yes` is BRouter's own note
 * about which way it traversed the way — but nothing here cares, since it only
 * ever looks up keys it knows.
 */
export function parseTags(text: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const pair of text.split(/\s+/)) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    tags[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return tags;
}

const PAVED = new Set([
  "asphalt",
  "chipseal",
  "concrete",
  "concrete:lanes",
  "concrete:plates",
  "metal",
  "paved",
  "paving_stones",
  "sett",
  "cobblestone",
  "unhewn_cobblestone",
  "wood",
]);

const UNPAVED = new Set([
  "compacted",
  "dirt",
  "earth",
  "fine_gravel",
  "grass",
  "grass_paver",
  "gravel",
  "ground",
  "mud",
  "pebblestone",
  "rock",
  "sand",
  "unpaved",
  "woodchips",
]);

/**
 * Roads that are surfaced unless something says otherwise.
 *
 * `cycleway` and `footway` are in here because an untagged one is far more
 * often a surfaced path through a town than a dirt trail; `path` is not,
 * because in open country it usually is.
 */
const PAVED_HIGHWAYS = new Set([
  "motorway",
  "motorway_link",
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "pedestrian",
  "cycleway",
  "footway",
]);

const UNPAVED_HIGHWAYS = new Set(["track", "path", "bridleway"]);

/**
 * What a way is surfaced with, best effort.
 *
 * A ladder, because `surface` is simply absent on a great many rural French
 * ways and refusing to guess would make the whole thing useless there:
 *
 * 1. `surface`, when it is there and recognised — the only real answer;
 * 2. `tracktype`, which grades a track from "solid" to "soft" and is often
 *    tagged where `surface` is not;
 * 3. the kind of road it is, which is a decent prior: a `residential` is
 *    surfaced and a `track` is not, often enough to be worth saying.
 *
 * Anything else is `unknown` and is reported as such rather than folded into a
 * neighbouring class, so a route whose surface nobody has recorded says so.
 */
export function classifySurface(tags: Record<string, string>): Surface {
  const surface = tags["surface"];
  if (surface) {
    if (PAVED.has(surface)) return "paved";
    if (UNPAVED.has(surface)) return "unpaved";
  }

  // grade1 is "solid", which rides like a road; everything below it does not.
  const tracktype = tags["tracktype"];
  if (tracktype === "grade1") return "paved";
  if (tracktype && /^grade[2-5]$/.test(tracktype)) return "unpaved";

  const highway = tags["highway"];
  if (highway) {
    if (PAVED_HIGHWAYS.has(highway)) return "paved";
    if (UNPAVED_HIGHWAYS.has(highway)) return "unpaved";
  }

  return "unknown";
}

/** How the surface was decided, for saying so rather than implying certainty. */
export type SurfaceEvidence = "surface" | "tracktype" | "highway" | "none";

export function surfaceEvidence(tags: Record<string, string>): SurfaceEvidence {
  const surface = tags["surface"];
  if (surface && (PAVED.has(surface) || UNPAVED.has(surface))) return "surface";
  const tracktype = tags["tracktype"];
  if (tracktype && /^grade[1-5]$/.test(tracktype)) return "tracktype";
  const highway = tags["highway"];
  if (highway && (PAVED_HIGHWAYS.has(highway) || UNPAVED_HIGHWAYS.has(highway))) return "highway";
  return "none";
}

/**
 * The surface at each sample of an evenly spaced profile.
 *
 * `ways` are the stretches BRouter reported, in order along the route, each
 * with its own length; `sampleKm` is the along-route distance of each profile
 * sample. Sample `i` is given the surface at the middle of the stretch it
 * covers — the one from sample `i - 1` — because that is the stretch the timing
 * charges for. Sample 0 covers nothing and takes the first way's surface.
 *
 * The way lengths are scaled onto the route's own length before matching. They
 * are BRouter's measurement of the road and `sampleKm` is ours off the returned
 * polyline, and the two differ by a little; without scaling that difference
 * accumulates and the last kilometre of a long route gets the wrong surface.
 *
 * With no ways — a server that reports no tags — every sample is `unknown`,
 * which the model prices explicitly rather than guessing at.
 */
export function surfacesAlong(
  ways: ReadonlyArray<{ metres: number; tags: Record<string, string> }>,
  sampleKm: readonly number[],
): Surface[] {
  if (sampleKm.length === 0) return [];
  if (ways.length === 0) return sampleKm.map(() => "unknown");

  const classified = ways.map((way) => classifySurface(way.tags));
  const declared = ways.reduce((total, way) => total + way.metres, 0);
  const routeMetres = (sampleKm.at(-1) ?? 0) * 1000;
  const scale = declared > 0 && routeMetres > 0 ? routeMetres / declared : 1;

  // Where each way ends, in the same measure as sampleKm.
  const ends: number[] = [];
  let running = 0;
  for (const way of ways) {
    running += way.metres * scale;
    ends.push(running);
  }

  const out: Surface[] = [classified[0]!];
  let cursor = 0;
  for (let i = 1; i < sampleKm.length; i++) {
    const middle = (((sampleKm[i] ?? 0) + (sampleKm[i - 1] ?? 0)) / 2) * 1000;
    while (cursor < ends.length - 1 && ends[cursor]! < middle) cursor++;
    out.push(classified[cursor]!);
  }
  return out;
}

/** How much of a ride, by whatever `weights` measures, sits on each surface. */
export function surfaceShares(
  surfaces: readonly Surface[],
  weights: readonly number[],
): Record<Surface, number> {
  const totals: Record<Surface, number> = { paved: 0, unpaved: 0, unknown: 0 };
  for (let i = 1; i < weights.length; i++) {
    const step = Math.max(0, (weights[i] ?? 0) - (weights[i - 1] ?? 0));
    totals[surfaces[i] ?? "unknown"] += step;
  }
  return totals;
}
