import type {
  Pattern,
  PatternTrip,
  ServiceCalendar,
  ServiceDate,
  Stop,
  TimetableIndex,
} from "../shared/types.js";
import { openMember } from "./archive.js";
import { at, columnIndex, parseCsv } from "./csv.js";
import { emptyCalendar } from "./calendar.js";
import { diagnose, keepRoute, type RouteFilter, type RouteInfo } from "./routeFilter.js";
import { parseTime } from "./time.js";

export interface LoadOptions {
  /** Path to the feed: a .zip, or a directory of already extracted .txt files. */
  zipPath: string;
  /** A route is kept when any pattern matches its agency / long name / description. */
  keepRoutePatterns: RegExp[];
  /** ...unless any of these matches, which wins over `keepRoutePatterns`. */
  dropRoutePatterns: RegExp[];
  /** When set, restricts to these route_type values instead of "any rail type". */
  keepRouteTypes?: number[];
  /** Print the full route diagnostic, then continue. */
  explainRoutes?: boolean;
}

interface RawTrip {
  serviceId: string;
  headsign: string;
  routeName: string;
  stops: number[];
  arrivals: number[];
  departures: number[];
  sequence: number[];
}

async function readTable(
  zipPath: string,
  filename: string,
  onRow: (row: string[], header: string[]) => void,
  { required = true }: { required?: boolean } = {},
): Promise<number> {
  const member = await openMember(zipPath, filename);
  if (!member) {
    if (required) throw new Error(`${filename} is missing from ${zipPath}`);
    return 0;
  }
  let header: string[] | null = null;
  let count = 0;
  try {
    for await (const row of parseCsv(member.stream)) {
      if (!header) {
        header = row;
        continue;
      }
      onRow(row, header);
      count++;
    }
  } finally {
    member.stream.destroy();
    await member.close();
  }
  return count;
}

export async function loadTimetable(options: LoadOptions): Promise<TimetableIndex> {
  const { zipPath } = options;

  // --- agencies -------------------------------------------------------------
  const agencyNames = new Map<string, string>();
  await readTable(
    zipPath,
    "agency.txt",
    (row, header) => {
      const [id, name] = columnIndex(header, "agency_id", "agency_name");
      agencyNames.set(at(row, id!), at(row, name!));
    },
    { required: false },
  );

  // --- routes ---------------------------------------------------------------
  const filter: RouteFilter = {
    keepPatterns: options.keepRoutePatterns,
    dropPatterns: options.dropRoutePatterns,
    ...(options.keepRouteTypes ? { keepTypes: options.keepRouteTypes } : {}),
  };

  const allRoutes: RouteInfo[] = [];
  const keptRoutes = new Map<string, string>();
  await readTable(zipPath, "routes.txt", (row, header) => {
    const [id, agency, shortName, longName, desc, type] = columnIndex(
      header,
      "route_id",
      "agency_id",
      "route_short_name",
      "route_long_name",
      "route_desc",
      "route_type",
    );
    const info: RouteInfo = {
      routeId: at(row, id!),
      // Falls back to the raw agency_id when agency.txt has no matching row.
      agencyName: agencyNames.get(at(row, agency!)) ?? at(row, agency!),
      shortName: at(row, shortName!),
      longName: at(row, longName!),
      description: at(row, desc!),
      routeType: at(row, type!),
    };
    allRoutes.push(info);
    if (keepRoute(info, filter)) {
      keptRoutes.set(info.routeId, info.longName || info.shortName || info.routeId);
    }
  });

  if (options.explainRoutes) {
    console.log(`\n${diagnose(allRoutes, filter)}\n`);
  }
  console.log(`Routes: kept ${keptRoutes.size} of ${allRoutes.length}`);

  if (keptRoutes.size === 0) {
    // Print the diagnostic rather than asking for another run: re-running means
    // re-reading the whole feed, and the answer is already in hand right here.
    throw new Error(
      "No routes matched the filter.\n\n" +
        (options.explainRoutes ? "" : `${diagnose(allRoutes, filter)}\n\n`) +
        "Adjust gtfs.keepRoutePatterns / gtfs.dropRoutePatterns (or set\n" +
        "gtfs.keepRouteTypes to the route_type values you want) in config/home.json.",
    );
  }

  // --- trips ----------------------------------------------------------------
  const trips = new Map<string, RawTrip>();
  await readTable(zipPath, "trips.txt", (row, header) => {
    const [tripId, routeId, serviceId, headsign] = columnIndex(
      header,
      "trip_id",
      "route_id",
      "service_id",
      "trip_headsign",
    );
    const routeName = keptRoutes.get(at(row, routeId!));
    if (routeName === undefined) return;
    trips.set(at(row, tripId!), {
      serviceId: at(row, serviceId!),
      headsign: at(row, headsign!),
      routeName,
      stops: [],
      arrivals: [],
      departures: [],
      sequence: [],
    });
  });
  console.log(`Trips: kept ${trips.size}`);

  // --- calendars ------------------------------------------------------------
  const services = new Map<string, ServiceCalendar>();
  const ensure = (id: string): ServiceCalendar => {
    let calendar = services.get(id);
    if (!calendar) services.set(id, (calendar = emptyCalendar()));
    return calendar;
  };

  await readTable(
    zipPath,
    "calendar.txt",
    (row, header) => {
      const [id, mon, tue, wed, thu, fri, sat, sun, start, end] = columnIndex(
        header,
        "service_id",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "start_date",
        "end_date",
      );
      const calendar = ensure(at(row, id!));
      const days = [mon!, tue!, wed!, thu!, fri!, sat!, sun!];
      for (let d = 0; d < 7; d++) {
        if (at(row, days[d]!) === "1") calendar.weekdayMask |= 1 << d;
      }
      calendar.start = Number(at(row, start!)) || 0;
      calendar.end = Number(at(row, end!)) || 0;
    },
    { required: false },
  );

  await readTable(
    zipPath,
    "calendar_dates.txt",
    (row, header) => {
      const [id, date, exception] = columnIndex(
        header,
        "service_id",
        "date",
        "exception_type",
      );
      const day = Number(at(row, date!));
      if (!day) return;
      const calendar = ensure(at(row, id!));
      if (at(row, exception!) === "2") calendar.removed.add(day);
      else calendar.added.add(day);
    },
    { required: false },
  );

  let feedStart = 99999999;
  let feedEnd = 0;
  for (const calendar of services.values()) {
    if (calendar.weekdayMask !== 0 && calendar.start > 0) {
      feedStart = Math.min(feedStart, calendar.start);
      feedEnd = Math.max(feedEnd, calendar.end);
    }
    for (const day of calendar.added) {
      feedStart = Math.min(feedStart, day);
      feedEnd = Math.max(feedEnd, day);
    }
  }
  if (feedEnd === 0) throw new Error("Feed has no usable calendar.txt or calendar_dates.txt");

  // --- stops ----------------------------------------------------------------
  const allStops = new Map<string, Stop>();
  await readTable(zipPath, "stops.txt", (row, header) => {
    const [id, name, lat, lon, parent] = columnIndex(
      header,
      "stop_id",
      "stop_name",
      "stop_lat",
      "stop_lon",
      "parent_station",
    );
    const stopId = at(row, id!);
    const parentId = at(row, parent!);
    allStops.set(stopId, {
      id: stopId,
      name: at(row, name!),
      lat: Number(at(row, lat!)),
      lon: Number(at(row, lon!)),
      station: parentId || stopId,
    });
  });

  // --- stop_times -----------------------------------------------------------
  const stops: Stop[] = [];
  const stopIndex = new Map<string, number>();
  const indexOfStop = (stopId: string): number => {
    const existing = stopIndex.get(stopId);
    if (existing !== undefined) return existing;
    const stop = allStops.get(stopId) ?? {
      id: stopId,
      name: stopId,
      lat: NaN,
      lon: NaN,
      station: stopId,
    };
    stopIndex.set(stopId, stops.length);
    stops.push(stop);
    return stops.length - 1;
  };

  let scanned = 0;
  await readTable(zipPath, "stop_times.txt", (row, header) => {
    if (++scanned % 2_000_000 === 0) console.log(`  stop_times: ${scanned / 1e6}M rows scanned`);
    const [tripId, arrival, departure, stopId, sequence] = columnIndex(
      header,
      "trip_id",
      "arrival_time",
      "departure_time",
      "stop_id",
      "stop_sequence",
    );
    const trip = trips.get(at(row, tripId!));
    if (!trip) return;
    trip.stops.push(indexOfStop(at(row, stopId!)));
    trip.arrivals.push(parseTime(at(row, arrival!)));
    trip.departures.push(parseTime(at(row, departure!)));
    trip.sequence.push(Number(at(row, sequence!)));
  });
  console.log(`stop_times: ${scanned} rows scanned, ${stops.length} stops in use`);

  // --- patterns -------------------------------------------------------------
  const patternsBySignature = new Map<string, Pattern>();
  let dropped = 0;
  for (const [tripId, trip] of trips) {
    if (trip.stops.length < 2) {
      dropped++;
      continue;
    }
    const order = trip.stops.map((_, i) => i).sort((a, b) => trip.sequence[a]! - trip.sequence[b]!);
    const orderedStops = order.map((i) => trip.stops[i]!);
    const times = buildTimes(order, trip);
    if (!times) {
      dropped++;
      continue;
    }

    const signature = orderedStops.join(",");
    let pattern = patternsBySignature.get(signature);
    if (!pattern) {
      pattern = { id: patternsBySignature.size, stops: orderedStops, trips: [] };
      patternsBySignature.set(signature, pattern);
    }
    pattern.trips.push({
      tripId,
      serviceId: trip.serviceId,
      headsign: trip.headsign,
      routeName: trip.routeName,
      times,
    });
  }

  const patterns = [...patternsBySignature.values()];
  for (const pattern of patterns) {
    // RAPTOR relies on trips being ordered so the first boardable one is also
    // the earliest-arriving; overtaking within a pattern is vanishingly rare on
    // rail and this ordering is the standard assumption.
    pattern.trips.sort((a, b) => a.times[1]! - b.times[1]!);
  }

  const patternsAtStop: number[][] = Array.from({ length: stops.length }, () => []);
  for (const pattern of patterns) {
    const seen = new Set<number>();
    for (const stop of pattern.stops) {
      if (seen.has(stop)) continue;
      seen.add(stop);
      patternsAtStop[stop]!.push(pattern.id);
    }
  }

  const stopsInStation = new Map<string, number[]>();
  for (let i = 0; i < stops.length; i++) {
    const station = stops[i]!.station;
    const group = stopsInStation.get(station);
    if (group) group.push(i);
    else stopsInStation.set(station, [i]);
  }

  console.log(
    `Patterns: ${patterns.length} over ${stops.length} stops` +
      (dropped ? ` (${dropped} trips dropped as unusable)` : ""),
  );

  return {
    stops,
    stopIndex,
    stopsInStation,
    patterns,
    patternsAtStop,
    services,
    feedStart,
    feedEnd,
  };
}

/**
 * Flattens a trip's stop times into [arrival, departure] pairs, filling any
 * blanks by interpolating between the surrounding timed stops. Returns null if
 * the trip has too few real times to be usable.
 */
function buildTimes(order: number[], trip: RawTrip): Int32Array | null {
  const n = order.length;
  const arrivals = new Int32Array(n);
  const departures = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const src = order[i]!;
    const arrival = trip.arrivals[src]!;
    const departure = trip.departures[src]!;
    arrivals[i] = arrival >= 0 ? arrival : departure;
    departures[i] = departure >= 0 ? departure : arrival;
  }
  if (arrivals[0]! < 0 || departures[n - 1]! < 0) return null;

  for (let i = 0; i < n; i++) {
    if (arrivals[i]! >= 0) continue;
    let next = i;
    while (next < n && arrivals[next]! < 0) next++;
    if (next >= n) return null;
    const before = departures[i - 1]!;
    const span = next - i + 1;
    const step = (arrivals[next]! - before) / span;
    for (let k = i; k < next; k++) {
      arrivals[k] = Math.round(before + step * (k - i + 1));
      departures[k] = arrivals[k]!;
    }
    i = next - 1;
  }

  const times = new Int32Array(n * 2);
  for (let i = 0; i < n; i++) {
    times[i * 2] = arrivals[i]!;
    times[i * 2 + 1] = departures[i]!;
    if (i > 0 && times[i * 2]! < times[i * 2 - 1]!) return null;
  }
  return times;
}
