import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { Itinerary, TimetableIndex } from "../shared/types.js";
import { formatDate, formatDuration, formatTime } from "../gtfs/time.js";
import { formatHours, formatHoursCeil } from "../shared/format.js";
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
  /** Minutes spent waiting at the station before this leg. 0 on the first. */
  waitMinutes: number;
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
  /** The longest wait at any change, which is what makes a trip tiresome. */
  worstWaitMinutes: number;
  /** The line of the final leg, used to group stations onto one corridor. */
  corridor: string;
}

export interface PlanRejection {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
  /** "tooShort" if the ride is not worth the fare, "overruns" if it is too long. */
  verdict: "tooShort" | "overruns" | "unroutable";
  km: number;
  hours: number;
  trainHours: number;
  /** For "overruns": the budgetHours that would let this trip in. */
  neededBudgetHours: number | null;
}

export interface Plan {
  generatedAt: string;
  home: { station: StationMatch; rideTo: Point };
  feed: { source: string; start: string; end: string };
  settings: {
    arriveBy: string;
    budgetHours: number;
    minRideHours: number;
    maxDays: number;
    hoursPerDay: number;
    speedKmh: number;
    climbMetresPerHour: number;
    maxTransfers: number;
    minTransferMinutes: number;
    maxTransferMinutes: number;
    dayType: string;
    mapStyleUrl: string;
  };
  months: Array<{ key: string; label: string; date: string; destinations: PlanDestination[] }>;
  /** Keyed by station id and shared across months: the ride home never changes. */
  rides: Record<string, RideVariant[]>;
  /** Stations reached by train but with no ride home that fits the budget. */
  rejected: PlanRejection[];
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
      maxTransferSeconds: config.trip.maxTransferSeconds,
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

      // "Worth the fare" is a property of the place, not of the route you
      // choose: if the most direct way home is short, dawdling back by a longer
      // one does not make it a trip you needed a train for.
      const shortest = result.variants.reduce<number>(
        (least, v) => Math.min(least, v.hours),
        Infinity,
      );
      const usable =
        shortest < config.ride.budget.minHours
          ? []
          : result.variants.filter((v) => v.feasible);

      if (usable.length === 0) {
        rejected.push(diagnose(target, result.variants, config.ride.budget.minHours));
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

    const tooShort = rejected.filter((r) => r.verdict === "tooShort");
    if (tooShort.length > 0) {
      console.log(
        `\n${tooShort.length} dropped as not worth the fare ` +
          `(under ${config.ride.budget.minHours} h riding): ` +
          tooShort.map((r) => r.name).join(", "),
      );
    }

    // The near misses are the useful ones: they say what budget would let each
    // in, so the setting can be chosen rather than guessed at.
    const overrunning = rejected
      .filter((r) => r.verdict === "overruns" && r.neededBudgetHours !== null)
      .sort((a, b) => a.neededBudgetHours! - b.neededBudgetHours!);
    if (overrunning.length > 0) {
      console.log(`\nJust out of reach on a ${config.ride.budget.budgetHours} h budget:`);
      for (const miss of overrunning.slice(0, 12)) {
        console.log(
          `  ${miss.name.padEnd(30)} ${miss.km.toFixed(0).padStart(4)} km, ` +
            `${formatHours(miss.hours)} riding + ${formatHours(miss.trainHours)} train ` +
            `= needs a ${formatHoursCeil(miss.neededBudgetHours!)} day`,
        );
      }
      if (overrunning.length > 12) console.log(`  ... and ${overrunning.length - 12} more`);
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
      minRideHours: config.ride.budget.minHours,
      minTransferMinutes: config.trip.minTransferSeconds / 60,
      maxTransferMinutes: config.trip.maxTransferSeconds / 60,
      dayType: config.dayType,
      mapStyleUrl: config.map.styleUrl,
    },
    months,
    rides,
    rejected,
  };
}

/**
 * Explains why a station that the train reaches did not make the cut.
 *
 * The blamed variant is the one that came closest: the longest ride when they
 * are all too short to be worth the fare, and otherwise the one needing the
 * smallest budget, which is the number to raise if you want it in.
 */
function diagnose(
  target: { point: StationMatch; trainHours: number },
  variants: RideVariant[],
  minHours: number,
): PlanRejection {
  const base = {
    stationId: target.point.stationId,
    name: target.point.name,
    lat: target.point.lat,
    lon: target.point.lon,
    trainHours: target.trainHours,
  };

  if (variants.length === 0) {
    return { ...base, verdict: "unroutable", km: 0, hours: 0, neededBudgetHours: null };
  }

  // The direct route decides whether the place was worth the fare, so that is
  // the one to report back.
  const shortest = variants.reduce((a, b) => (b.hours < a.hours ? b : a));
  if (shortest.hours < minHours) {
    return {
      ...base,
      verdict: "tooShort",
      km: shortest.km,
      hours: shortest.hours,
      neededBudgetHours: null,
    };
  }

  const overrunning = variants.filter((v) => v.verdict === "overruns");
  if (overrunning.length === 0) {
    const longest = variants.reduce((a, b) => (b.hours > a.hours ? b : a));
    return {
      ...base,
      verdict: "tooShort",
      km: longest.km,
      hours: longest.hours,
      neededBudgetHours: null,
    };
  }

  const closest = overrunning.reduce((a, b) =>
    (b.neededBudgetHours ?? Infinity) < (a.neededBudgetHours ?? Infinity) ? b : a,
  );
  return {
    ...base,
    verdict: "overruns",
    km: closest.km,
    hours: closest.hours,
    neededBudgetHours: closest.neededBudgetHours,
  };
}

function toDestination(itinerary: Itinerary): PlanDestination {
  const legs = itinerary.legs.map((leg, i) => {
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
      waitMinutes:
        i === 0 ? 0 : Math.round((leg.departure - itinerary.legs[i - 1]!.arrival) / 60),
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
    worstWaitMinutes: Math.max(0, ...legs.map((l) => l.waitMinutes)),
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
