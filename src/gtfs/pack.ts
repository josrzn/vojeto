import type {
  Pattern,
  PatternTrip,
  ServiceCalendar,
  ServiceDate,
  Stop,
  TimetableIndex,
} from "../shared/types.js";
import { deriveLookups } from "./lookups.js";

/**
 * The timetable as two files a browser can fetch.
 *
 * Parsing the feed takes a 4 MB zip, 378,000 CSV rows and several seconds; a
 * page cannot do that on every visit. So `ingest` does it once and writes what
 * it built, in a shape that loads in one `JSON.parse` and one `ArrayBuffer`.
 *
 * Two files rather than one, split where the bytes are. Times are three
 * quarters of the whole index and are the only part that wants to be a typed
 * array — both on the wire and in memory, where an `Int32Array` costs a
 * quarter of what the same numbers cost as a JS array. Everything else stays
 * JSON: it is a fraction of the size, it gzips well, and it can be opened and
 * read when something looks wrong. Hand-rolling a binary header for the sake of
 * another hundred kilobytes would trade that away for the one class of bug —
 * an offset off by one field — that is invisible until a single train has the
 * wrong departure time.
 *
 * The format carries no derived lookups. `stopIndex`, `stopsInStation` and
 * `patternsAtStop` are rebuilt by `deriveLookups`, the same function the
 * parser uses, so the two cannot disagree.
 */
export interface PackedTimetable {
  version: 1;
  /**
   * Every distinct string, referenced by index everywhere else.
   *
   * Route names and headsigns repeat across tens of thousands of trips. Without
   * this they would be stored — and, after `JSON.parse`, held in memory — once
   * per trip rather than once.
   */
  strings: string[];
  stops: {
    id: number[];
    name: number[];
    station: number[];
    /** Kept as JSON numbers so a decoded stop sits at exactly the parsed one. */
    lat: number[];
    lon: number[];
  };
  patterns: {
    /** Start of each pattern's stop list in `stops`, with a final end marker. */
    stopStart: number[];
    stops: number[];
    /** Start of each pattern's trips in the trip arrays, with an end marker. */
    tripStart: number[];
  };
  trips: {
    tripId: number[];
    serviceId: number[];
    headsign: number[];
    routeName: number[];
    /** Start of each trip's times in the times buffer, with an end marker. */
    timeStart: number[];
  };
  services: Array<{
    id: number;
    weekdayMask: number;
    start: ServiceDate;
    end: ServiceDate;
    added: ServiceDate[];
    removed: ServiceDate[];
  }>;
  feedStart: ServiceDate;
  feedEnd: ServiceDate;
  plannableEnd: ServiceDate;
  /** Flat [date, count] pairs. */
  servicesPerDate: number[];
}

/** Interns strings as they are written, so each is stored once. */
function interner() {
  const strings: string[] = [];
  const seen = new Map<string, number>();
  return {
    strings,
    ref(value: string): number {
      const existing = seen.get(value);
      if (existing !== undefined) return existing;
      seen.set(value, strings.length);
      strings.push(value);
      return strings.length - 1;
    },
  };
}

export function packTimetable(index: TimetableIndex): {
  meta: PackedTimetable;
  times: Int32Array;
} {
  const { strings, ref } = interner();

  const stops = {
    id: [] as number[],
    name: [] as number[],
    station: [] as number[],
    lat: [] as number[],
    lon: [] as number[],
  };
  for (const stop of index.stops) {
    stops.id.push(ref(stop.id));
    stops.name.push(ref(stop.name));
    stops.station.push(ref(stop.station));
    stops.lat.push(stop.lat);
    stops.lon.push(stop.lon);
  }

  const patternStopStart: number[] = [];
  const patternStops: number[] = [];
  const patternTripStart: number[] = [];
  const trips = {
    tripId: [] as number[],
    serviceId: [] as number[],
    headsign: [] as number[],
    routeName: [] as number[],
    timeStart: [] as number[],
  };

  // Times are written into one growing array first and copied into an
  // Int32Array at the end: the total is not known until every trip is seen.
  const times: number[] = [];

  for (const pattern of index.patterns) {
    patternStopStart.push(patternStops.length);
    patternStops.push(...pattern.stops);
    patternTripStart.push(trips.tripId.length);
    for (const trip of pattern.trips) {
      trips.tripId.push(ref(trip.tripId));
      trips.serviceId.push(ref(trip.serviceId));
      trips.headsign.push(ref(trip.headsign));
      trips.routeName.push(ref(trip.routeName));
      trips.timeStart.push(times.length);
      for (const time of trip.times) times.push(time);
    }
  }
  // End markers, so every span is `start[i]` to `start[i + 1]` with no special
  // case for the last one.
  patternStopStart.push(patternStops.length);
  patternTripStart.push(trips.tripId.length);
  trips.timeStart.push(times.length);

  const services = [...index.services].map(([id, calendar]) => ({
    id: ref(id),
    weekdayMask: calendar.weekdayMask,
    start: calendar.start,
    end: calendar.end,
    added: [...calendar.added],
    removed: [...calendar.removed],
  }));

  return {
    meta: {
      version: 1,
      strings,
      stops,
      patterns: {
        stopStart: patternStopStart,
        stops: patternStops,
        tripStart: patternTripStart,
      },
      trips,
      services,
      feedStart: index.feedStart,
      feedEnd: index.feedEnd,
      plannableEnd: index.plannableEnd,
      servicesPerDate: [...index.servicesPerDate].flat(),
    },
    times: Int32Array.from(times),
  };
}

export function unpackTimetable(meta: PackedTimetable, times: Int32Array): TimetableIndex {
  if (meta.version !== 1) {
    throw new Error(`Timetable index is version ${meta.version}, this build reads version 1`);
  }
  const text = (at: number): string => {
    const value = meta.strings[at];
    if (value === undefined) throw new Error(`Timetable index references string ${at}, which is missing`);
    return value;
  };

  const stops: Stop[] = meta.stops.id.map((id, i) => ({
    id: text(id),
    name: text(meta.stops.name[i]!),
    lat: meta.stops.lat[i]!,
    lon: meta.stops.lon[i]!,
    station: text(meta.stops.station[i]!),
  }));

  const patterns: Pattern[] = [];
  const patternCount = meta.patterns.stopStart.length - 1;
  for (let id = 0; id < patternCount; id++) {
    const patternTrips: PatternTrip[] = [];
    for (let t = meta.patterns.tripStart[id]!; t < meta.patterns.tripStart[id + 1]!; t++) {
      patternTrips.push({
        tripId: text(meta.trips.tripId[t]!),
        serviceId: text(meta.trips.serviceId[t]!),
        headsign: text(meta.trips.headsign[t]!),
        routeName: text(meta.trips.routeName[t]!),
        // A view onto the shared buffer rather than a copy: the times are the
        // bulk of the index, and RAPTOR only ever reads them.
        times: times.subarray(meta.trips.timeStart[t]!, meta.trips.timeStart[t + 1]!),
      });
    }
    patterns.push({
      id,
      stops: meta.patterns.stops.slice(
        meta.patterns.stopStart[id]!,
        meta.patterns.stopStart[id + 1]!,
      ),
      trips: patternTrips,
    });
  }

  const services = new Map<string, ServiceCalendar>(
    meta.services.map((service) => [
      text(service.id),
      {
        weekdayMask: service.weekdayMask,
        start: service.start,
        end: service.end,
        added: new Set(service.added),
        removed: new Set(service.removed),
      },
    ]),
  );

  const servicesPerDate = new Map<ServiceDate, number>();
  for (let i = 0; i + 1 < meta.servicesPerDate.length; i += 2) {
    servicesPerDate.set(meta.servicesPerDate[i]!, meta.servicesPerDate[i + 1]!);
  }

  return {
    stops,
    patterns,
    ...deriveLookups(stops, patterns),
    services,
    feedStart: meta.feedStart,
    feedEnd: meta.feedEnd,
    plannableEnd: meta.plannableEnd,
    servicesPerDate,
  };
}
