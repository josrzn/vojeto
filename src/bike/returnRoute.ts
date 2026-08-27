import type { TimetableIndex } from "../shared/types.js";
import { cumulativeDistances, haversine, nearest, type Point } from "../shared/geo.js";
import { routeBike, type BRouterOptions } from "./brouter.js";
import {
  elapsedHours,
  fitsBudget,
  rideHours,
  type Budget,
  type EffortModel,
  type Verdict,
} from "./effort.js";

export interface BailoutStation {
  stationId: string;
  name: string;
  /** How far off the route the station is, in km. */
  detourKm: number;
}

export interface RideStage {
  day: number;
  km: number;
  ascentMetres: number;
  hours: number;
  end: Point;
  /** Nearest station to the overnight stop, if you want to cut the ride short. */
  bailout: BailoutStation | null;
}

/** One way home: a profile paired with one of BRouter's alternative lines. */
export interface RideVariant {
  id: string;
  label: string;
  profile: string;
  alternative: number;
  km: number;
  ascentMetres: number;
  /** Our own estimate, from distance and climb. */
  hours: number;
  /** BRouter's estimate for the profile, kept for comparison. */
  brouterHours: number;
  days: number;
  feasible: boolean;
  /** Why it does or does not work: "fits", "tooShort" or "overruns". */
  verdict: Verdict;
  /** Spare hours on the last day; negative means it overruns. */
  slackHours: number;
  /** For "overruns": the budgetHours that would let this ride in. */
  neededBudgetHours: number | null;
  stages: RideStage[];
  /** Simplified [lon, lat] polyline, small enough to ship to the browser. */
  geometry: number[][];
  /**
   * The router's untouched [lon, lat, elevation] track.
   *
   * Kept apart from `geometry` because the two have different jobs: the map
   * wants few points, a GPX wants every one of them and the elevation too.
   * Stripped out of plan.json before it is written; it goes to a .gpx instead.
   */
  track: number[][];
}

export interface VariantSpec {
  id: string;
  label: string;
  profile: string;
}

export interface RideOptions extends Omit<BRouterOptions, "profile" | "alternative"> {
  variants: VariantSpec[];
  /** How many of BRouter's alternative lines to ask for per profile. */
  alternatives: number;
  effort: EffortModel;
  budget: Budget;
  /** Hours already spent on the train, which come out of the day's budget. */
  trainHours: number;
  /** A station further than this from an overnight stop is not a useful escape. */
  maxBailoutKm?: number;
}

export interface RideResult {
  variants: RideVariant[];
  /** Profiles the server would not route, so they can be reported once. */
  failures: Array<{ id: string; reason: string }>;
}

/** Every distinct station in the feed that has usable coordinates. */
export function stationPoints(
  index: TimetableIndex,
): Array<Point & { stationId: string; name: string }> {
  const seen = new Map<string, Point & { stationId: string; name: string }>();
  for (const stop of index.stops) {
    if (seen.has(stop.station)) continue;
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
    seen.set(stop.station, {
      stationId: stop.station,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
    });
  }
  return [...seen.values()];
}

/**
 * Plans every configured way of riding from a station back home.
 *
 * A failed profile is reported rather than thrown: a server without a `gravel`
 * profile should still give you the trekking route.
 */
export async function planRidesHome(
  from: Point,
  home: Point,
  stations: Array<Point & { stationId: string; name: string }>,
  options: RideOptions,
): Promise<RideResult> {
  const variants: RideVariant[] = [];
  const failures: RideResult["failures"] = [];

  for (const spec of options.variants) {
    for (let alternative = 0; alternative < Math.max(1, options.alternatives); alternative++) {
      const id = alternative === 0 ? spec.id : `${spec.id}-${alternative + 1}`;
      try {
        variants.push(
          await planOne(from, home, stations, options, spec, alternative, id),
        );
      } catch (error) {
        failures.push({ id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  // Two alternatives from one profile are often the same road; drop repeats.
  const unique: RideVariant[] = [];
  for (const variant of variants) {
    const duplicate = unique.some(
      (kept) =>
        kept.profile === variant.profile && Math.abs(kept.km - variant.km) < 0.05,
    );
    if (!duplicate) unique.push(variant);
  }

  unique.sort((a, b) => Number(b.feasible) - Number(a.feasible) || a.hours - b.hours);
  return { variants: unique, failures };
}

async function planOne(
  from: Point,
  home: Point,
  stations: Array<Point & { stationId: string; name: string }>,
  options: RideOptions,
  spec: VariantSpec,
  alternative: number,
  id: string,
): Promise<RideVariant> {
  const track = await routeBike([from, home], {
    baseUrl: options.baseUrl,
    cacheDir: options.cacheDir,
    profile: spec.profile,
    alternative,
    ...(options.throttleMs !== undefined ? { throttleMs: options.throttleMs } : {}),
  });

  // Distances are measured off the returned polyline rather than taken from
  // BRouter's own track-length, so the stage lengths always add up to the total.
  const distances = cumulativeDistances(track.coordinates);
  const totalMetres = distances.at(-1) ?? 0;
  const km = totalMetres / 1000;

  const effortHours = cumulativeEffort(track.coordinates, distances, options.effort);
  const totalHours = effortHours.at(-1) ?? 0;
  // The headline figure uses BRouter's filtered ascent, which is steadier than
  // summing raw per-vertex elevation deltas; the per-segment totals above are
  // only used to decide where the days should break.
  const hours = rideHours(km, track.ascentMetres, options.effort);
  const verdict = fitsBudget(options.trainHours, hours, options.budget);

  const boundaries = dayBoundaries(hours, options.trainHours, options.budget, verdict.days);
  const stages: RideStage[] = [];
  let previousVertex = 0;
  let previousHours = 0;

  for (let day = 0; day < boundaries.length; day++) {
    const untilHours = boundaries[day]!;
    const vertex =
      day === boundaries.length - 1
        ? track.coordinates.length - 1
        : vertexAtEffort(effortHours, (untilHours / hours) * totalHours);
    const end: Point = {
      lon: track.coordinates[vertex]![0]!,
      lat: track.coordinates[vertex]![1]!,
    };
    stages.push({
      day: day + 1,
      km: (distances[vertex]! - distances[previousVertex]!) / 1000,
      ascentMetres: Math.round(
        track.ascentMetres * fraction(effortHours, previousVertex, vertex, totalHours),
      ),
      hours: untilHours - previousHours,
      end,
      bailout:
        day === boundaries.length - 1
          ? null
          : findBailout(end, stations, options.maxBailoutKm ?? 15),
    });
    previousVertex = vertex;
    previousHours = untilHours;
  }

  return {
    id,
    label: spec.label,
    profile: spec.profile,
    alternative,
    km,
    ascentMetres: track.ascentMetres,
    hours,
    brouterHours: track.estimatedSeconds / 3600,
    days: verdict.days,
    feasible: verdict.feasible,
    verdict: verdict.verdict,
    slackHours: verdict.slackHours,
    neededBudgetHours: verdict.neededBudgetHours,
    stages,
    geometry: simplify(track.coordinates, 150),
    track: track.coordinates,
  };
}

/**
 * Cumulative hours of effort at each vertex, by the same model as rideHours.
 *
 * An adapter onto `elapsedHours`, which the profile chart's time axis also uses:
 * where a day ends and where the chart puts a climb are the same question asked
 * of different point spacings, and they should not be able to disagree.
 */
function cumulativeEffort(
  coordinates: number[][],
  distances: number[],
  model: EffortModel,
): number[] {
  return elapsedHours(
    distances.map((metres) => metres / 1000),
    coordinates.map((vertex) => vertex[2] ?? 0),
    model,
  );
}

/** Running total of hours at which each day should end. */
function dayBoundaries(
  hours: number,
  trainHours: number,
  budget: Budget,
  days: number,
): number[] {
  if (!Number.isFinite(days) || days <= 1) return [hours];
  const firstDay = Math.max(0, budget.budgetHours - trainHours);
  const boundaries: number[] = [];
  for (let day = 0; day < days - 1; day++) {
    boundaries.push(Math.min(hours, firstDay + day * budget.hoursPerDay));
  }
  boundaries.push(hours);
  return boundaries;
}

function fraction(effortHours: number[], from: number, to: number, total: number): number {
  if (total <= 0) return 0;
  return (effortHours[to]! - effortHours[from]!) / total;
}

/** First vertex at or past `hours` of cumulative effort. */
function vertexAtEffort(effortHours: number[], hours: number): number {
  let low = 0;
  let high = effortHours.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (effortHours[mid]! < hours) low = mid + 1;
    else high = mid;
  }
  return low;
}

function findBailout(
  point: Point,
  stations: Array<Point & { stationId: string; name: string }>,
  maxKm: number,
): BailoutStation | null {
  const closest = nearest(point, stations);
  if (!closest || closest.metres > maxKm * 1000) return null;
  return {
    stationId: closest.item.stationId,
    name: closest.item.name,
    detourKm: closest.metres / 1000,
  };
}

/**
 * Ramer-Douglas-Peucker, dropping altitude. A cross-France route is thousands
 * of vertices; at a ~150 m tolerance it stays visually identical on a map but
 * ships a fraction of the JSON.
 */
export function simplify(coordinates: number[][], toleranceMetres: number): number[][] {
  if (coordinates.length <= 2) return coordinates.map((c) => [c[0]!, c[1]!]);

  const keep = new Uint8Array(coordinates.length);
  keep[0] = 1;
  keep[coordinates.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, coordinates.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let furthest = -1;
    let maxDistance = toleranceMetres;
    for (let i = start + 1; i < end; i++) {
      const distance = perpendicularDistance(coordinates[i]!, coordinates[start]!, coordinates[end]!);
      if (distance > maxDistance) {
        maxDistance = distance;
        furthest = i;
      }
    }
    if (furthest < 0) continue;
    keep[furthest] = 1;
    stack.push([start, furthest], [furthest, end]);
  }

  const result: number[][] = [];
  for (let i = 0; i < coordinates.length; i++) {
    if (keep[i]) result.push([coordinates[i]![0]!, coordinates[i]![1]!]);
  }
  return result;
}

function perpendicularDistance(point: number[], start: number[], end: number[]): number {
  const p = { lon: point[0]!, lat: point[1]! };
  const a = { lon: start[0]!, lat: start[1]! };
  const b = { lon: end[0]!, lat: end[1]! };

  const segment = haversine(a, b);
  if (segment === 0) return haversine(p, a);

  // Project in a locally flat frame; over a segment this short the error is
  // far below the tolerance we are comparing against.
  const scale = Math.cos((a.lat * Math.PI) / 180);
  const ax = a.lon * scale;
  const bx = b.lon * scale;
  const px = p.lon * scale;
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * (bx - ax) + (p.lat - a.lat) * (b.lat - a.lat)) /
      ((bx - ax) ** 2 + (b.lat - a.lat) ** 2)),
  );
  return haversine(p, { lon: (ax + t * (bx - ax)) / scale, lat: a.lat + t * (b.lat - a.lat) });
}
