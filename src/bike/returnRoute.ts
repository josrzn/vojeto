import type { TimetableIndex } from "../shared/types.js";
import { cumulativeDistances, haversine, nearest, type Point } from "../shared/geo.js";
import { routeBike, type BRouterOptions } from "./brouter.js";
import {
  measureRide,
  type MeasureOptions,
  type RideVariant,
  type VariantSpec,
} from "./measure.js";

export { measureRide, simplify } from "./measure.js";
export type {
  BailoutStation,
  MeasureOptions,
  RideStage,
  RideVariant,
  VariantSpec,
} from "./measure.js";
import { resampleByDistance, smoothElevation } from "./profile.js";
import { surfaceShares, surfacesAlong, type Surface } from "./surface.js";
import { elapsedHours, fitsBudget, type Budget, type EffortModel, type Verdict } from "./effort.js";

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
  return measureRide(track, stations, spec, alternative, options);
}
