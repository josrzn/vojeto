import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { Itinerary, TimetableIndex } from "../shared/types.js";
import { formatDate, formatDuration, formatTime } from "../gtfs/time.js";
import { reachableStations } from "../router/raptor.js";
import { planRidesHome, stationPoints, type RideVariant } from "../bike/returnRoute.js";
import { maxRideKm } from "../bike/effort.js";
import { haversine, type Point } from "../shared/geo.js";
import { resolveHome, type StationMatch } from "./stations.js";
import { sampleDates } from "./dates.js";

export interface PlanLeg {
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
}

export interface PlanDestination {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  departure: string;
  arrival: string;
  /** "1h20" */
  travel: string;
  travelMinutes: number;
  transfers: number;
  legs: PlanLeg[];
  /** The line of the final leg, used to group stations onto one corridor. */
  corridor: string;
}

export interface Plan {
  generatedAt: string;
  home: { station: StationMatch; rideTo: Point };
  feed: { source: string; start: string; end: string };
  settings: {
    arriveBy: string;
    budgetHours: number;
    maxDays: number;
    hoursPerDay: number;
    speedKmh: number;
    climbMetresPerHour: number;
    maxTransfers: number;
    dayType: string;
    mapStyleUrl: string;
  };
  months: Array<{ key: string; label: string; date: string; destinations: PlanDestination[] }>;
  /** Keyed by station id and shared across months: the ride home never changes. */
  rides: Record<string, RideVariant[]>;
  /** Stations reached by train but with no ride home that fits the budget. */
  rejected: Array<{ stationId: string; name: string; reason: string }>;
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
  const station = resolveHome(index, config.home.station);
  const rideTo = config.home.rideTo;
  console.log(
    `Home: train from ${station.name} (${station.stationId}), ` +
      `ride back to ${rideTo.lat.toFixed(5)}, ${rideTo.lon.toFixed(5)} ` +
      `(${(haversine(station, rideTo) / 1000).toFixed(1)} km apart)`,
  );

  const dates = sampleDates(index.feedStart, index.plannableEnd, config.dayType);
  if (dates.length === 0) {
    throw new Error(
      `The feed is plannable from ${formatDate(index.feedStart)} to ` +
        `${formatDate(index.plannableEnd)}, which contains no future ${config.dayType}.`,
    );
  }

  const months: Plan["months"] = [];
  const candidates = new Map<string, { point: StationMatch; trainHours: number }>();

  for (const sample of dates) {
    const itineraries = reachableStations(index, {
      date: sample.date,
      origin: station.stationId,
      earliestDeparture: config.trip.earliestDeparture,
      arriveBy: config.trip.arriveBy,
      arriveNoEarlierThan: config.trip.arriveNoEarlierThan,
      maxTravelSeconds: config.trip.maxTravelSeconds,
      maxTransfers: config.trip.maxTransfers,
      minTransferSeconds: config.trip.minTransferSeconds,
    });

    const destinations: PlanDestination[] = [];
    let outOfRange = 0;
    for (const itinerary of itineraries) {
      if (!Number.isFinite(itinerary.lat) || !Number.isFinite(itinerary.lon)) continue;

      // A ride can only be longer than the straight line, so anything already
      // beyond what the budget allows is not worth asking BRouter about.
      const trainHours = itinerary.duration / 3600;
      const reach = maxRideKm(trainHours, config.ride.budget, config.ride.effort);
      if (haversine(rideTo, itinerary) / 1000 > reach) {
        outOfRange++;
        continue;
      }

      destinations.push(toDestination(itinerary));
      const existing = candidates.get(itinerary.destination);
      // Keep the quickest train seen for this station, since that leaves the
      // most time for riding and so decides whether the trip is possible.
      if (!existing || trainHours < existing.trainHours) {
        candidates.set(itinerary.destination, {
          point: {
            stationId: itinerary.destination,
            name: itinerary.destinationName,
            lat: itinerary.lat,
            lon: itinerary.lon,
          },
          trainHours,
        });
      }
    }

    console.log(
      `${sample.label} (${formatDate(sample.date)}): ${itineraries.length} reachable, ` +
        `${destinations.length} within riding range` +
        (outOfRange ? ` (${outOfRange} too far to ride back)` : ""),
    );
    months.push({
      key: sample.key,
      label: sample.label,
      date: formatDate(sample.date),
      destinations,
    });
  }

  const ordered = [...candidates.values()].sort(
    (a, b) => haversine(rideTo, a.point) - haversine(rideTo, b.point),
  );
  const targets = options.limit ? ordered.slice(0, options.limit) : ordered;

  const rides: Record<string, RideVariant[]> = {};
  const rejected: Plan["rejected"] = [];

  if (!options.skipBike) {
    const stations = stationPoints(index);
    const perTarget = config.ride.variants.length * config.ride.alternatives;
    console.log(
      `\nRouting ${targets.length} rides home ` +
        `(${config.ride.variants.length} profiles x ${config.ride.alternatives} alternatives, ` +
        `cached in ${options.cacheDir})`,
    );

    const reportedFailures = new Set<string>();
    let done = 0;
    for (const target of targets) {
      done++;
      const result = await planRidesHome(target.point, rideTo, stations, {
        baseUrl: config.ride.brouterUrl,
        cacheDir: options.cacheDir,
        variants: config.ride.variants,
        alternatives: config.ride.alternatives,
        effort: config.ride.effort,
        budget: config.ride.budget,
        trainHours: target.trainHours,
      });

      for (const failure of result.failures) {
        // Report a broken profile once, not once per destination.
        if (reportedFailures.has(failure.id)) continue;
        reportedFailures.add(failure.id);
        console.warn(`  profile "${failure.id}" unavailable: ${failure.reason}`);
      }

      const usable = result.variants.filter((v) => v.feasible);
      if (usable.length === 0) {
        const best = result.variants[0];
        rejected.push({
          stationId: target.point.stationId,
          name: target.point.name,
          reason: best
            ? `${best.km.toFixed(0)} km / ${best.hours.toFixed(1)} h riding does not fit ` +
              `${config.ride.budget.budgetHours} h minus ${target.trainHours.toFixed(1)} h on the train`
            : "no cycling route found",
        });
        continue;
      }

      // Keep the unusable ones too: seeing why a station just missed out is
      // more useful than it silently vanishing.
      rides[target.point.stationId] = result.variants;
      const best = usable[0]!;
      console.log(
        `  [${done}/${targets.length}] ${target.point.name}: ` +
          `${best.km.toFixed(0)} km, +${best.ascentMetres} m, ${best.hours.toFixed(1)} h` +
          `${best.days > 1 ? `, ${best.days} days` : ""}` +
          ` (${usable.length}/${perTarget} variants fit)`,
      );
    }

    const routable = new Set(Object.keys(rides));
    for (const month of months) {
      month.destinations = month.destinations.filter((d) => routable.has(d.stationId));
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    home: { station, rideTo },
    feed: {
      source: config.gtfs.url,
      start: formatDate(index.feedStart),
      end: formatDate(index.plannableEnd),
    },
    settings: {
      arriveBy: formatTime(config.trip.arriveBy),
      budgetHours: config.ride.budget.budgetHours,
      maxDays: config.ride.budget.maxDays,
      hoursPerDay: config.ride.budget.hoursPerDay,
      speedKmh: config.ride.effort.speedKmh,
      climbMetresPerHour: config.ride.effort.climbMetresPerHour,
      maxTransfers: config.trip.maxTransfers,
      dayType: config.dayType,
      mapStyleUrl: config.map.styleUrl,
    },
    months,
    rides,
    rejected,
  };
}

function toDestination(itinerary: Itinerary): PlanDestination {
  const legs = itinerary.legs.map((leg) => {
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
  });

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
    legs,
    // Stations along one line make near-identical trips at different lengths,
    // so the line of the last leg is what the UI groups them by.
    corridor: legs.at(-1)?.route ?? "",
  };
}

export async function writePlan(plan: Plan, file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const json = JSON.stringify(plan);
  await writeFile(file, json);
  console.log(`\nWrote ${file} (${(Buffer.byteLength(json) / 1024).toFixed(0)} KB)`);
}
