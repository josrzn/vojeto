import { readFile } from "node:fs/promises";
import { requireTime } from "./gtfs/time.js";

export interface Config {
  home: { query: string; stopId: string | null };
  trip: {
    arriveBy: number;
    arriveNoEarlierThan: number;
    earliestDeparture: number;
    maxTravelSeconds: number;
    maxTransfers: number;
    minTransferSeconds: number;
  };
  bike: { profile: string; kmPerDay: number; maxTotalKm: number; brouterUrl: string };
  gtfs: {
    url: string;
    keepRoutePatterns: RegExp[];
    dropRoutePatterns: RegExp[];
    /** Optional: restrict to these route_type values instead of "any rail type". */
    keepRouteTypes: number[] | undefined;
  };
  map: { styleUrl: string };
  /** Which day of the week each month's sample date should fall on. */
  dayType: "saturday" | "sunday" | "weekday";
}

interface RawConfig {
  home?: { query?: string; stopId?: string | null };
  trip?: Record<string, string | number>;
  bike?: Record<string, string | number>;
  gtfs?: {
    url?: string;
    keepRoutePatterns?: string[];
    dropRoutePatterns?: string[];
    keepRouteTypes?: number[];
  };
  map?: { styleUrl?: string };
  dayType?: string;
}

const DAY_TYPES = ["saturday", "sunday", "weekday"] as const;

export async function loadConfig(file = "config/home.json"): Promise<Config> {
  const raw = JSON.parse(await readFile(file, "utf8")) as RawConfig;

  const trip = raw.trip ?? {};
  const bike = raw.bike ?? {};
  const gtfs = raw.gtfs ?? {};
  const dayType = raw.dayType ?? "saturday";
  if (!(DAY_TYPES as readonly string[]).includes(dayType)) {
    throw new Error(`${file}: dayType must be one of ${DAY_TYPES.join(", ")}`);
  }

  if (!raw.home?.query && !raw.home?.stopId) {
    throw new Error(`${file}: set home.query (a station name) or home.stopId`);
  }

  return {
    home: { query: String(raw.home.query ?? ""), stopId: raw.home.stopId ?? null },
    trip: {
      arriveBy: requireTime(String(trip.arriveBy ?? "09:00"), "trip.arriveBy"),
      arriveNoEarlierThan: requireTime(
        String(trip.arriveNoEarlierThan ?? "06:00"),
        "trip.arriveNoEarlierThan",
      ),
      earliestDeparture: requireTime(
        String(trip.earliestDeparture ?? "05:00"),
        "trip.earliestDeparture",
      ),
      maxTravelSeconds: Number(trip.maxTravelMinutes ?? 240) * 60,
      maxTransfers: Number(trip.maxTransfers ?? 2),
      minTransferSeconds: Number(trip.minTransferMinutes ?? 5) * 60,
    },
    bike: {
      profile: String(bike.profile ?? "trekking"),
      kmPerDay: Number(bike.kmPerDay ?? 90),
      maxTotalKm: Number(bike.maxTotalKm ?? 400),
      brouterUrl: String(bike.brouterUrl ?? "https://brouter.de/brouter"),
    },
    gtfs: {
      url: String(gtfs.url ?? ""),
      keepRoutePatterns: (gtfs.keepRoutePatterns ?? ["\\bTER\\b"]).map((p) => new RegExp(p, "i")),
      dropRoutePatterns: (gtfs.dropRoutePatterns ?? []).map((p) => new RegExp(p, "i")),
      keepRouteTypes: gtfs.keepRouteTypes?.map(Number),
    },
    map: { styleUrl: String(raw.map?.styleUrl ?? "https://tiles.openfreemap.org/styles/liberty") },
    dayType: dayType as Config["dayType"],
  };
}
