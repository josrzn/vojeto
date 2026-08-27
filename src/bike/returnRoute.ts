import type { TimetableIndex } from "../shared/types.js";
import { cumulativeDistances, haversine, nearest, type Point } from "../shared/geo.js";
import { routeBike, type BRouterOptions } from "./brouter.js";
import { resampleByDistance, smoothElevation } from "./profile.js";
import { elapsedHours, fitsBudget, type Budget, type EffortModel, type Verdict } from "./effort.js";

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
  /**
   * Which of this profile's routes this is, quickest first, counting from 1.
   *
   * What the label shows. Distinct from `alternative`, which records only which
   * request produced it.
   */
  rank: number;
  /** BRouter's `alternativeidx`, kept for tracing a route back to its request. */
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
  /**
   * Spacing the route is resampled at before it is timed, in metres.
   *
   * Matters now that speed depends on gradient: gradient taken between the
   * router's own vertices, which can be metres apart, is mostly noise off the
   * elevation model, and a curve turns noise into time. Same value the shipped
   * profile uses, so the chart and the duration are the same calculation.
   */
  profileStepMetres: number;
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
  const unique: RideVariant[] = [];
  const failures: RideResult["failures"] = [];

  for (const spec of options.variants) {
    const routed: Array<Omit<RideVariant, "id" | "rank">> = [];
    for (let alternative = 0; alternative < Math.max(1, options.alternatives); alternative++) {
      try {
        routed.push(await planOne(from, home, stations, options, spec, alternative));
      } catch (error) {
        failures.push({
          id: spec.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Two alternatives from one profile are often the same road; drop repeats.
    const kept = routed.filter(
      (variant, i) => !routed.slice(0, i).some((other) => Math.abs(other.km - variant.km) < 0.05),
    );

    // Numbered by how long they take, so "Gravel" is the quickest way home on
    // gravel and "Gravel 2" is the longer one. BRouter's `alternativeidx` is a
    // request parameter, not a fact about the road: its first answer is not
    // more canonical than its second, and letting it number the list means the
    // label contradicts the order the list is sorted in.
    kept.sort((a, b) => a.hours - b.hours);
    for (const [i, variant] of kept.entries()) {
      unique.push({ ...variant, rank: i + 1, id: i === 0 ? spec.id : `${spec.id}-${i + 1}` });
    }
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
): Promise<Omit<RideVariant, "id" | "rank">> {
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

  const shape = profileOf(track.coordinates, options.profileStepMetres, totalMetres);
  const effortHours = elapsedHours(shape.km, shape.ele, options.effort);
  const hours = effortHours.at(-1) ?? 0;
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
        : vertexAtDistance(distances, interpolate(effortHours, shape.km, untilHours) * 1000);
    const end: Point = {
      lon: track.coordinates[vertex]![0]!,
      lat: track.coordinates[vertex]![1]!,
    };
    stages.push({
      day: day + 1,
      km: (distances[vertex]! - distances[previousVertex]!) / 1000,
      ascentMetres: Math.round(
        interpolate(shape.km, shape.ascent, distances[vertex]! / 1000) -
          interpolate(shape.km, shape.ascent, distances[previousVertex]! / 1000),
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
    label: spec.label,
    profile: spec.profile,
    alternative,
    km,
    ascentMetres: Math.round(shape.ascent.at(-1) ?? 0),
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
 * The shape of the route, at even spacing, as three series along it.
 *
 * The same resample-then-smooth the browser is sent, so the duration here and
 * the chart there are one calculation rather than two that happen to agree. The
 * router's raw vertices cannot be used for this: they are spaced by OSM node,
 * so a gradient taken between two of them is as much an artefact of where a road
 * happens to bend as of the hill, and a speed curve charges real time for that.
 *
 * Distances are along the road — the resampler lands on exact multiples of the
 * step — rather than straight lines between samples, which would quietly lose a
 * little length on every bend.
 */
function profileOf(
  coordinates: number[][],
  stepMetres: number,
  totalMetres: number,
): { km: number[]; ele: number[]; ascent: number[] } {
  const resampled = resampleByDistance(coordinates, stepMetres);
  const points = smoothElevation(resampled.points, 3);
  const km = points.map((_, i) => Math.min(i * stepMetres, totalMetres) / 1000);
  const ele = points.map((point) => point[2] ?? 0);
  const ascent = [0];
  for (let i = 1; i < ele.length; i++) {
    ascent.push(ascent[i - 1]! + Math.max(0, ele[i]! - ele[i - 1]!));
  }
  return { km, ele, ascent };
}

/**
 * Reads `ys` at the point where `xs` reaches `x`, interpolating between samples.
 *
 * `xs` must increase. Used both ways round — hours to distance for a day
 * boundary, distance to ascent for a stage total — which is why it is written
 * as a lookup rather than as either.
 */
function interpolate(xs: number[], ys: number[], x: number): number {
  if (xs.length === 0) return 0;
  if (x <= xs[0]!) return ys[0]!;
  const last = xs.length - 1;
  if (x >= xs[last]!) return ys[last]!;

  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! <= x) lo = mid;
    else hi = mid;
  }
  const span = xs[hi]! - xs[lo]!;
  const t = span > 0 ? (x - xs[lo]!) / span : 0;
  return ys[lo]! + (ys[hi]! - ys[lo]!) * t;
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

/**
 * First vertex of the raw track at or past `metres` along it.
 *
 * Days are decided on the resampled profile but have to end at a real point on
 * the line, because that is what a bailout station is measured from.
 */
function vertexAtDistance(distances: number[], metres: number): number {
  let low = 0;
  let high = distances.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (distances[mid]! < metres) low = mid + 1;
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
