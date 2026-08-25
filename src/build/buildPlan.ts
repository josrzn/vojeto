import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { Itinerary, TimetableIndex } from "../shared/types.js";
import { formatDate, formatDuration, formatTime } from "../gtfs/time.js";
import { reachableStations } from "../router/raptor.js";
import { planRideHome, stationPoints, type RideHome } from "../bike/returnRoute.js";
import { haversine } from "../shared/geo.js";
import { resolveHome, type StationMatch } from "./stations.js";
import { sampleDates } from "./dates.js";

export interface PlanDestination {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  /** "07:20" */
  departure: string;
  arrival: string;
  /** "1h20" */
  travel: string;
  travelMinutes: number;
  transfers: number;
  legs: Array<{
    from: string;
    to: string;
    departure: string;
    arrival: string;
    /** The line, e.g. "Lyon Perrache - Lyon Part Dieu - Roanne". */
    route: string;
    /** Where the train is going, when the feed says. Empty if it does not. */
    towards: string;
    /** The train number, when the feed puts one in trip_headsign. */
    trainNumber: string;
  }>;
}

export interface Plan {
  generatedAt: string;
  home: StationMatch;
  feed: { source: string; start: string; end: string };
  settings: {
    arriveBy: string;
    maxTravelMinutes: number;
    maxTransfers: number;
    kmPerDay: number;
    bikeProfile: string;
    dayType: string;
    mapStyleUrl: string;
  };
  months: Array<{ key: string; label: string; date: string; destinations: PlanDestination[] }>;
  /** Keyed by station id and shared across months: the ride home never changes. */
  rides: Record<string, RideHome>;
  /** Stations reachable by train but with no cycling route home. */
  unroutable: Array<{ stationId: string; name: string; reason: string }>;
}

export interface BuildOptions {
  /** Only route the N nearest destinations. Useful for a quick first run. */
  limit?: number;
  /** Skip BRouter entirely and emit train results only. */
  skipBike?: boolean;
  cacheDir: string;
}

export async function buildPlan(
  index: TimetableIndex,
  config: Config,
  options: BuildOptions,
): Promise<Plan> {
  const home = resolveHome(index, config.home);
  console.log(`Home: ${home.name} (${home.stationId})`);

  const dates = sampleDates(index.feedStart, index.plannableEnd, config.dayType);
  if (dates.length === 0) {
    throw new Error(
      `The feed is plannable from ${formatDate(index.feedStart)} to ` +
        `${formatDate(index.plannableEnd)}, ` +
        `which contains no future ${config.dayType}.`,
    );
  }

  const months: Plan["months"] = [];
  const candidates = new Map<string, StationMatch>();

  for (const sample of dates) {
    const itineraries = reachableStations(index, {
      date: sample.date,
      origin: home.stationId,
      earliestDeparture: config.trip.earliestDeparture,
      arriveBy: config.trip.arriveBy,
      arriveNoEarlierThan: config.trip.arriveNoEarlierThan,
      maxTravelSeconds: config.trip.maxTravelSeconds,
      maxTransfers: config.trip.maxTransfers,
      minTransferSeconds: config.trip.minTransferSeconds,
    });

    console.log(
      `${sample.label} (${formatDate(sample.date)}): ${itineraries.length} stations reachable`,
    );

    const destinations: PlanDestination[] = [];
    for (const itinerary of itineraries) {
      if (!Number.isFinite(itinerary.lat) || !Number.isFinite(itinerary.lon)) continue;
      // A ride home can only be longer than the straight line, so anything
      // beyond the limit as the crow flies is not worth asking BRouter about.
      const crowKm = haversine(home, itinerary) / 1000;
      if (crowKm > config.bike.maxTotalKm) continue;

      destinations.push(toDestination(itinerary));
      candidates.set(itinerary.destination, {
        stationId: itinerary.destination,
        name: itinerary.destinationName,
        lat: itinerary.lat,
        lon: itinerary.lon,
      });
    }
    months.push({
      key: sample.key,
      label: sample.label,
      date: formatDate(sample.date),
      destinations,
    });
  }

  const ordered = [...candidates.values()].sort(
    (a, b) => haversine(home, a) - haversine(home, b),
  );
  const targets = options.limit ? ordered.slice(0, options.limit) : ordered;

  const rides: Record<string, RideHome> = {};
  const unroutable: Plan["unroutable"] = [];

  if (!options.skipBike) {
    const stations = stationPoints(index);
    console.log(`\nRouting ${targets.length} rides home with BRouter (cached in ${options.cacheDir})`);

    let done = 0;
    for (const target of targets) {
      done++;
      try {
        rides[target.stationId] = await planRideHome(target, home, stations, {
          baseUrl: config.bike.brouterUrl,
          profile: config.bike.profile,
          cacheDir: options.cacheDir,
          kmPerDay: config.bike.kmPerDay,
          maxTotalKm: config.bike.maxTotalKm,
        });
        const ride = rides[target.stationId]!;
        console.log(
          `  [${done}/${targets.length}] ${target.name}: ` +
            `${ride.km.toFixed(0)} km, +${ride.ascentMetres} m, ${ride.days} day(s)`,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`  [${done}/${targets.length}] ${target.name}: no route (${reason})`);
        unroutable.push({ stationId: target.stationId, name: target.name, reason });
      }
    }
  }

  // Drop destinations we could not route home; they are not trips you can take.
  const routable = new Set(Object.keys(rides));
  if (!options.skipBike) {
    for (const month of months) {
      month.destinations = month.destinations.filter((d) => routable.has(d.stationId));
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    home,
    feed: {
      source: config.gtfs.url,
      start: formatDate(index.feedStart),
      end: formatDate(index.plannableEnd),
    },
    settings: {
      arriveBy: formatTime(config.trip.arriveBy),
      maxTravelMinutes: config.trip.maxTravelSeconds / 60,
      maxTransfers: config.trip.maxTransfers,
      kmPerDay: config.bike.kmPerDay,
      bikeProfile: config.bike.profile,
      dayType: config.dayType,
      mapStyleUrl: config.map.styleUrl,
    },
    months,
    rides,
    unroutable,
  };
}

function toDestination(itinerary: Itinerary): PlanDestination {
  return {
    stationId: itinerary.destination,
    name: itinerary.destinationName,
    lat: itinerary.lat,
    lon: itinerary.lon,
    departure: formatTime(itinerary.departure),
    arrival: formatTime(itinerary.arrival),
    travel: formatDuration(itinerary.duration),
    travelMinutes: Math.round(itinerary.duration / 60),
    transfers: itinerary.transfers,
    legs: itinerary.legs.map((leg) => {
      // The SNCF feed puts the train number in trip_headsign rather than a
      // destination, so a numeric value is labelled as such instead of
      // being shown as "towards 886917".
      const isTrainNumber = /^\d+$/.test(leg.headsign.trim());
      return {
        from: leg.fromName,
        to: leg.toName,
        departure: formatTime(leg.departure),
        arrival: formatTime(leg.arrival),
        route: leg.routeName,
        towards: isTrainNumber ? "" : leg.headsign,
        trainNumber: isTrainNumber ? leg.headsign.trim() : "",
      };
    }),
  };
}

export async function writePlan(plan: Plan, file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(plan));
  const bytes = Buffer.byteLength(JSON.stringify(plan));
  console.log(`\nWrote ${file} (${(bytes / 1024).toFixed(0)} KB)`);
}
