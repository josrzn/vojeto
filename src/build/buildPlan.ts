import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { Itinerary, TimetableIndex } from "../shared/types.js";
import { formatDate, formatTime } from "../gtfs/time.js";
import { formatHours, formatHoursCeil } from "../shared/format.js";
import { reachableStations } from "../router/raptor.js";
import { planRidesHome, stationPoints, type RideVariant } from "../bike/returnRoute.js";
import { densify, describeRide, slug, toGpx } from "../bike/gpx.js";
import { compact, resampleByDistance, smoothElevation } from "../bike/profile.js";
import { maxRideKm } from "../bike/effort.js";
import type { SpeedCurves } from "../bike/speed.js";
import { SURFACES } from "../bike/surface.js";
import type { Grid } from "../bike/contour.js";
import { haversine, type Point } from "../shared/geo.js";
import { resolveHome, type StationMatch } from "./stations.js";
import { toDestination, type PlanDestination } from "./destination.js";
import { sampleDates } from "./dates.js";

export type { PlanDestination, PlanLeg } from "./destination.js";

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

/**
 * A variant as shipped to the browser.
 *
 * The full track is replaced by two filenames: a .gpx to take away, and a
 * compact resampled profile fetched only when the variant is looked at. Neither
 * belongs in plan.json — together they would be several megabytes.
 */
export type PlanRideVariant = Omit<RideVariant, "track" | "surfaces"> & {
  gpx: string | null;
  /** Filename of the resampled elevation profile. Not `profile`, which is the
   *  BRouter profile this ride was routed with. */
  elevationFile: string | null;
};

export interface Plan {
  generatedAt: string;
  home: { station: StationMatch; rideTo: Point };
  feed: { source: string; start: string; end: string };
  settings: {
    arriveBy: string;
    /** The rest of the train query, so the browser can ask what the plan asked. */
    arriveNoEarlierThan: string;
    earliestDeparture: string;
    maxTravelMinutes: number;
    budgetHours: number;
    minRideHours: number;
    maxDays: number;
    hoursPerDay: number;
    /** The rider's speed against gradient and surface, so the browser times things the same way. */
    speedByGradient: SpeedCurves;
    maxTransfers: number;
    minTransferMinutes: number;
    maxTransferMinutes: number;
    dayType: string;
    mapStyleUrl: string;
    /**
     * Where to route, for rides the browser asks for itself.
     *
     * Shipped rather than hardcoded so that pointing at a self-hosted BRouter
     * is a config change: the public instance is donated hardware, and growing
     * past what is polite to ask of it should not need a code change.
     */
    brouterUrl: string;
    /**
     * The ways home worth offering, from config.
     *
     * Shipped because the browser routes on demand now and has to know what to
     * ask BRouter for. Config stays the one place they are named.
     */
    variants: Array<{ id: string; label: string; profile: string }>;
  };
  months: Array<{ key: string; label: string; date: string; destinations: PlanDestination[] }>;
  /** Keyed by station id and shared across months: the ride home never changes. */
  rides: Record<string, PlanRideVariant[]>;
  /**
   * Hours on the train to each station, as the plan judged it.
   *
   * The quickest train across every month, since that is the one leaving the
   * most time to ride. Shipped so the browser can re-decide what fits when you
   * move the budget without routing anything — and so that re-deciding at the
   * settings below reproduces this file exactly rather than approximately.
   */
  trainHours: Record<string, number>;
  /** Stations reached by train but with no ride home that fits the budget. */
  rejected: PlanRejection[];
  /**
   * Stations within riding range that no train reaches in time.
   *
   * The point of drawing these: somewhere like Moulins sits well inside the
   * ride-home contours, so the bike was never the problem. Showing it as a
   * station with no morning train says that far better than its absence does.
   */
  noTrain: Array<{ stationId: string; name: string; lat: number; lon: number }>;
  /**
   * Ride-time-home sampled on a grid, or null when not built.
   *
   * Deliberately separate from `rides`: the grid is a continuous backdrop for
   * the map, while `rides` are the real routes from actual stations. Only the
   * latter are trips you can take.
   */
  field: Grid | null;
}

export interface BuildOptions {
  /** Directory to write .gpx files into, alongside plan.json. */
  gpxDir?: string;
  /** Directory to write resampled elevation profiles into. */
  profileDir?: string;
  /** Only route the N nearest destinations. Useful for a quick first run. */
  limit?: number;
  /** Skip BRouter entirely and emit train results only. */
  skipBike?: boolean;
  /** Prebuilt ride-time field to embed, if one was sampled. */
  field?: Grid | null;
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
  // Every station any sampled date can reach, before the ride is considered.
  // "No train goes there" has to mean exactly that, not "the ride ruled it out"
  // and not "--limit stopped short of routing it".
  const trainReachable = new Set<string>();

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
      trainReachable.add(itinerary.destination);

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

  const rides: Record<string, PlanRideVariant[]> = {};
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
        profileStepMetres: config.ride.profileStepMetres,
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
      rides[target.point.stationId] = await Promise.all(
        result.variants.map((variant) =>
          exportVariant(variant, target.point.name, config, options),
        ),
      );
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
      arriveNoEarlierThan: formatTime(config.trip.arriveNoEarlierThan),
      earliestDeparture: formatTime(config.trip.earliestDeparture),
      maxTravelMinutes: Math.round(config.trip.maxTravelSeconds / 60),
      budgetHours: config.ride.budget.budgetHours,
      maxDays: config.ride.budget.maxDays,
      hoursPerDay: config.ride.budget.hoursPerDay,
      speedByGradient: config.ride.effort.curves,
      maxTransfers: config.trip.maxTransfers,
      minRideHours: config.ride.budget.minHours,
      minTransferMinutes: config.trip.minTransferSeconds / 60,
      maxTransferMinutes: config.trip.maxTransferSeconds / 60,
      dayType: config.dayType,
      mapStyleUrl: config.map.styleUrl,
      brouterUrl: config.ride.brouterUrl,
      variants: config.ride.variants.map((v) => ({ id: v.id, label: v.label, profile: v.profile })),
    },
    months,
    rides,
    trainHours: Object.fromEntries(
      [...candidates].map(([stationId, candidate]) => [stationId, candidate.trainHours]),
    ),
    rejected,
    noTrain: stationsWithoutTrains(index, rideTo, config, trainReachable, station),
    field: options.field ?? null,
  };
}

/**
 * TER stations close enough to ride home from that no month's trains reach.
 *
 * Bounded by the same reach as the destinations themselves, so the map only
 * shows places where the ride was genuinely never the obstacle.
 */
function stationsWithoutTrains(
  index: TimetableIndex,
  rideTo: Point,
  config: Config,
  trainReachable: ReadonlySet<string>,
  home: StationMatch,
): Plan["noTrain"] {
  const reachKm = maxRideKm(0, config.ride.budget, config.ride.effort);

  return stationPoints(index)
    .filter(
      (station) =>
        station.stationId !== home.stationId &&
        !trainReachable.has(station.stationId) &&
        haversine(rideTo, station) / 1000 <= reachKm,
    )
    .map(({ stationId, name, lat, lon }) => ({ stationId, name, lat, lon }));
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

/**
 * Writes a variant's .gpx and drops the full track from what ships.
 *
 * Every routed variant gets a file, including ones that overrun the budget:
 * the route exists and you may well want to ride it on a longer day, so there
 * is no reason to withhold it.
 */
async function exportVariant(
  variant: RideVariant,
  stationName: string,
  config: Config,
  options: BuildOptions,
): Promise<PlanRideVariant> {
  const { track, surfaces, ...rest } = variant;
  if (track.length < 2) return { ...rest, gpx: null, elevationFile: null };

  const key = `${slug(stationName)}-${slug(variant.id)}`;
  let profileFile: string | null = null;

  if (options.profileDir) {
    // Even spacing is the point: gradients taken between the router's own
    // points would each cover a different distance and not be comparable.
    const resampled = resampleByDistance(track, config.ride.profileStepMetres);
    const smoothed = { ...resampled, points: smoothElevation(resampled.points, 3) };

    // Surface travels as a parallel array of indices rather than a fourth
    // number on every point: it repeats for hundreds of samples at a time and
    // small integers compress to almost nothing.
    //
    // Shipped only when it lines up sample for sample with the profile. The two
    // are resampled by the same function at the same step so they always should,
    // but a mismatch would silently shift every surface along the ride, and no
    // surface at all is better than one that is subtly wrong.
    const aligned = surfaces.length === smoothed.points.length;
    if (!aligned && surfaces.length > 0) {
      console.warn(
        `  ${stationName} ${variant.id}: ${surfaces.length} surface samples for ` +
          `${smoothed.points.length} profile points, dropping the surfaces`,
      );
    }

    profileFile = `${key}.json`;
    await mkdir(options.profileDir, { recursive: true });
    await writeFile(
      path.join(options.profileDir, profileFile),
      JSON.stringify({
        ...compact(smoothed),
        ...(aligned ? { surfaces: surfaces.map((s) => SURFACES.indexOf(s)) } : {}),
      }),
    );
  }

  if (!options.gpxDir) return { ...rest, gpx: null, elevationFile: profileFile };

  const maxPointSpacingMetres = config.ride.gpxMaxPointSpacingMetres;
  const file = `${key}.gpx`;
  const summary = describeRide(variant);

  await mkdir(options.gpxDir, { recursive: true });
  await writeFile(
    path.join(options.gpxDir, file),
    toGpx({
      name: `${stationName} to home — ${variant.label}`,
      description: summary,
      coordinates: densify(track, maxPointSpacingMetres),
      time: new Date().toISOString(),
      waypoints: variant.stages.slice(0, -1).map((stage) => ({
        lat: stage.end.lat,
        lon: stage.end.lon,
        name: `Night ${stage.day}`,
        ...(stage.bailout
          ? { description: `${stage.bailout.detourKm.toFixed(1)} km from ${stage.bailout.name} station` }
          : {}),
      })),
    }),
  );

  return { ...rest, gpx: file, elevationFile: profileFile };
}


export async function writePlan(plan: Plan, file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const json = JSON.stringify(plan);
  await writeFile(file, json);
  console.log(`\nWrote ${file} (${(Buffer.byteLength(json) / 1024).toFixed(0)} KB)`);
}
