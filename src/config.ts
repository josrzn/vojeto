import { readFile } from "node:fs/promises";
import { requireTime } from "./gtfs/time.js";
import { parsePoint, type Point } from "./shared/geo.js";
import type { Budget, EffortModel } from "./bike/effort.js";
import {
  TOURING_CURVES,
  curveFromLinearModel,
  flatKmh,
  validateCurve,
  type SpeedCurve,
  type SpeedCurves,
} from "./bike/speed.js";
import { SURFACES } from "./bike/surface.js";
import type { VariantSpec } from "./bike/returnRoute.js";

export interface Config {
  home: {
    station: { query: string; stopId: string | null };
    /** Where the ride home ends, which need not be the station. */
    rideTo: Point;
  };
  trip: {
    arriveBy: number;
    arriveNoEarlierThan: number;
    earliestDeparture: number;
    maxTravelSeconds: number;
    maxTransfers: number;
    minTransferSeconds: number;
    maxTransferSeconds: number;
  };
  ride: {
    budget: Budget;
    effort: EffortModel;
    variants: VariantSpec[];
    alternatives: number;
    brouterUrl: string;
    field: { spacingKm: number; radiusKm: number };
    gpxMaxPointSpacingMetres: number;
    /** Spacing of the resampled elevation profile shipped to the browser. */
    profileStepMetres: number;
  };
  gtfs: {
    url: string;
    keepRoutePatterns: RegExp[];
    dropRoutePatterns: RegExp[];
    keepRouteTypes: number[] | undefined;
    keepStopKinds: string[];
  };
  map: { styleUrl: string };
  dayType: "saturday" | "sunday" | "weekday";
}

interface RawConfig {
  home?: {
    station?: { query?: string; stopId?: string | null };
    rideTo?: string;
    /** The pre-split shape, still recognised so the error can say what to do. */
    query?: string;
  };
  trip?: Record<string, string | number>;
  ride?: Record<string, unknown>;
  bike?: Record<string, unknown>;
  gtfs?: {
    url?: string;
    keepRoutePatterns?: string[];
    dropRoutePatterns?: string[];
    keepRouteTypes?: number[];
    keepStopKinds?: string[];
  };
  map?: { styleUrl?: string };
  dayType?: string;
}

const DAY_TYPES = ["saturday", "sunday", "weekday"] as const;

const DEFAULT_VARIANTS: VariantSpec[] = [
  { id: "trekking", label: "Quiet roads", profile: "trekking" },
];

export async function loadConfig(file = "config/home.json"): Promise<Config> {
  const raw = JSON.parse(await readFile(file, "utf8")) as RawConfig;

  if (raw.home?.query !== undefined || raw.bike !== undefined) {
    throw new Error(
      `${file} uses the old layout. "home.query" is now "home.station.query", ` +
        `"home" gained "rideTo" (where the ride ends), and the "bike" section is now ` +
        `"ride" with a time budget. See the README for the current shape.`,
    );
  }

  const trip = raw.trip ?? {};
  const ride = raw.ride ?? {};
  const gtfs = raw.gtfs ?? {};
  const dayType = raw.dayType ?? "saturday";
  if (!(DAY_TYPES as readonly string[]).includes(dayType)) {
    throw new Error(`${file}: dayType must be one of ${DAY_TYPES.join(", ")}`);
  }

  const station = raw.home?.station;
  if (!station?.query && !station?.stopId) {
    throw new Error(`${file}: set home.station.query (a station name) or home.station.stopId`);
  }
  if (!raw.home?.rideTo) {
    throw new Error(
      `${file}: set home.rideTo to where the ride home ends, ` +
        `e.g. "46.034389, 4.079342" or "46°02'03.80\\"N 4°04'45.63\\"E"`,
    );
  }

  const budgetHours = num(ride["budgetHours"], 6);
  const variants = parseVariants(ride["variants"], file);
  const curves = parseSpeedCurves(ride, file);

  return {
    home: {
      station: { query: String(station.query ?? ""), stopId: station.stopId ?? null },
      rideTo: parsePoint(raw.home.rideTo),
    },
    trip: {
      arriveBy: requireTime(String(trip["arriveBy"] ?? "09:00"), "trip.arriveBy"),
      arriveNoEarlierThan: requireTime(
        String(trip["arriveNoEarlierThan"] ?? "06:00"),
        "trip.arriveNoEarlierThan",
      ),
      earliestDeparture: requireTime(
        String(trip["earliestDeparture"] ?? "05:00"),
        "trip.earliestDeparture",
      ),
      maxTravelSeconds: Number(trip["maxTravelMinutes"] ?? 240) * 60,
      maxTransfers: Number(trip["maxTransfers"] ?? 0),
      minTransferSeconds: Number(trip["minTransferMinutes"] ?? 10) * 60,
      maxTransferSeconds: Number(trip["maxTransferMinutes"] ?? 30) * 60,
    },
    ride: {
      budget: {
        budgetHours,
        maxDays: Math.max(1, num(ride["maxDays"], 1)),
        hoursPerDay: num(ride["hoursPerDay"], budgetHours),
        minHours: Math.max(0, num(ride["minHours"], 0)),
      },
      effort: { curves },
      variants,
      alternatives: Math.max(1, num(ride["alternatives"], 1)),
      brouterUrl: String(ride["brouterUrl"] ?? "https://brouter.de/brouter"),
      field: parseField(ride["field"], budgetHours, flatKmh(curves.paved)),
      profileStepMetres: Math.max(10, num(ride["profileStepMetres"], 100)),
      gpxMaxPointSpacingMetres: Math.max(
        0,
        num((ride["gpx"] as Record<string, unknown> | undefined)?.["maxPointSpacingMetres"], 50),
      ),
    },
    gtfs: {
      url: String(gtfs.url ?? ""),
      // Defaults to empty: this feed's route names carry no service type, so
      // filtering is done on stop kinds instead.
      keepRoutePatterns: (gtfs.keepRoutePatterns ?? []).map((p) => new RegExp(p, "i")),
      dropRoutePatterns: (gtfs.dropRoutePatterns ?? []).map((p) => new RegExp(p, "i")),
      keepRouteTypes: gtfs.keepRouteTypes?.map(Number),
      keepStopKinds: gtfs.keepStopKinds ?? ["OCETrain TER"],
    },
    map: { styleUrl: String(raw.map?.styleUrl ?? "https://tiles.openfreemap.org/styles/liberty") },
    dayType: dayType as Config["dayType"],
  };
}

function num(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseField(
  value: unknown,
  budgetHours: number,
  speedKmh: number,
): { spacingKm: number; radiusKm: number } {
  const raw = (value ?? {}) as Record<string, unknown>;
  const radius = num(raw["radiusKm"], 0);
  return {
    spacingKm: Math.max(1, num(raw["spacingKm"], 20)),
    // Zero means "as far as the budget could possibly take you", which is the
    // whole area where a contour could matter.
    radiusKm: radius > 0 ? radius : Math.min(250, budgetHours * speedKmh),
  };
}

/** One list of `[gradient, km/h]` pairs, validated. */
function parseOneCurve(raw: unknown, where: string): SpeedCurve {
  if (!Array.isArray(raw)) {
    throw new Error(`${where} must be a list of [gradient, km/h] pairs`);
  }
  const curve = raw.map((entry, i) => {
    if (Array.isArray(entry) && entry.length === 2) {
      return { gradient: Number(entry[0]), kmh: Number(entry[1]) };
    }
    if (entry && typeof entry === "object" && "gradient" in entry && "kmh" in entry) {
      const pair = entry as { gradient: unknown; kmh: unknown };
      return { gradient: Number(pair.gradient), kmh: Number(pair.kmh) };
    }
    throw new Error(`${where}[${i}]: expected [gradient, km/h] or { gradient, kmh }`);
  });
  return validateCurve(curve, where);
}

/**
 * The rider's speed curves, from `ride.speedByGradient`.
 *
 * Three shapes are accepted, and which one you write says how much of the model
 * you want:
 *
 * - absent, with `ride.speedKmh` and `ride.climbMetresPerHour` present — the
 *   model from before curves existed, converted to the curve it always implied
 *   and used for every surface, so an old config still reports its old times
 *   rather than silently changing every number in the plan;
 * - a plain list — one curve for everything, gradient modelled and surface not;
 * - an object keyed by surface — the full model. `paved` is required; anything
 *   omitted falls back to it, so writing only `paved` is the same as writing a
 *   plain list.
 */
function parseSpeedCurves(ride: Record<string, unknown>, file: string): SpeedCurves {
  const raw = ride["speedByGradient"];
  const everywhere = (curve: SpeedCurve): SpeedCurves => ({
    paved: curve,
    unpaved: curve,
    unknown: curve,
  });

  if (raw === undefined) {
    if (ride["speedKmh"] === undefined && ride["climbMetresPerHour"] === undefined) {
      return TOURING_CURVES;
    }
    return everywhere(
      curveFromLinearModel(num(ride["speedKmh"], 16), num(ride["climbMetresPerHour"], 600)),
    );
  }

  if (Array.isArray(raw)) {
    return everywhere(parseOneCurve(raw, `${file}: ride.speedByGradient`));
  }

  if (typeof raw !== "object") {
    throw new Error(
      `${file}: ride.speedByGradient must be a list of pairs, or an object keyed by surface`,
    );
  }

  const byName = raw as Record<string, unknown>;
  const unexpected = Object.keys(byName).filter(
    (key) => !key.startsWith("$") && !SURFACES.includes(key as never),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `${file}: ride.speedByGradient has no surface named "${unexpected[0]}" ` +
        `(expected ${SURFACES.join(", ")})`,
    );
  }
  if (byName["paved"] === undefined) {
    throw new Error(`${file}: ride.speedByGradient needs at least a "paved" curve`);
  }

  const paved = parseOneCurve(byName["paved"], `${file}: ride.speedByGradient.paved`);
  const named = (surface: string): SpeedCurve =>
    byName[surface] === undefined
      ? paved
      : parseOneCurve(byName[surface], `${file}: ride.speedByGradient.${surface}`);
  return { paved, unpaved: named("unpaved"), unknown: named("unknown") };
}

function parseVariants(value: unknown, file: string): VariantSpec[] {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_VARIANTS;
  return value.map((entry, i) => {
    const spec = entry as Partial<VariantSpec>;
    if (!spec.profile) throw new Error(`${file}: ride.variants[${i}] needs a "profile"`);
    return {
      id: String(spec.id ?? spec.profile),
      label: String(spec.label ?? spec.profile),
      profile: String(spec.profile),
    };
  });
}
