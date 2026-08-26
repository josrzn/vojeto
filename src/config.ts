import { readFile } from "node:fs/promises";
import { requireTime } from "./gtfs/time.js";
import { parsePoint, type Point } from "./shared/geo.js";
import type { Budget, EffortModel } from "./bike/effort.js";
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
      effort: {
        speedKmh: num(ride["speedKmh"], 16),
        climbMetresPerHour: num(ride["climbMetresPerHour"], 600),
      },
      variants,
      alternatives: Math.max(1, num(ride["alternatives"], 1)),
      brouterUrl: String(ride["brouterUrl"] ?? "https://brouter.de/brouter"),
      field: parseField(ride["field"], budgetHours, num(ride["speedKmh"], 16)),
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
