/** Seconds after midnight of the service day. GTFS allows values >= 86400 for
 *  trips that run past midnight, so this is deliberately not clamped. */
export type ServiceTime = number;

/** GTFS `YYYYMMDD` as a plain number, e.g. 20260914. Cheap to compare and sort. */
export type ServiceDate = number;

export interface Stop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** parent_station, or the stop's own id when it is already a station. */
  station: string;
}

/** Trips sharing an identical stop sequence, which is the unit RAPTOR scans.
 *  GTFS route_id is too coarse: one route routinely mixes several stop patterns. */
export interface Pattern {
  id: number;
  /** Indices into TimetableIndex.stops. */
  stops: number[];
  /** Trips on this pattern, sorted by departure from the first stop. */
  trips: PatternTrip[];
}

export interface PatternTrip {
  tripId: string;
  serviceId: string;
  headsign: string;
  routeName: string;
  /** Flat pairs [arrival, departure] per stop, so index 2*i / 2*i+1. */
  times: Int32Array;
}

/**
 * A service's running days, kept as a rule rather than an expanded date set:
 * the SNCF feed has tens of thousands of service ids and expanding each to 150
 * dates costs far more memory than evaluating the rule per query.
 */
export interface ServiceCalendar {
  /** Bit 0 = Monday .. bit 6 = Sunday. Zero when the feed has no calendar.txt. */
  weekdayMask: number;
  start: ServiceDate;
  end: ServiceDate;
  /** calendar_dates.txt exception_type 1. */
  added: Set<ServiceDate>;
  /** calendar_dates.txt exception_type 2. */
  removed: Set<ServiceDate>;
}

export interface TimetableIndex {
  stops: Stop[];
  /** stop id -> index into `stops`. */
  stopIndex: Map<string, number>;
  /** station id -> indices into `stops` of every platform in it. */
  stopsInStation: Map<string, number[]>;
  patterns: Pattern[];
  /** stop index -> pattern ids that call there. */
  patternsAtStop: number[][];
  services: Map<string, ServiceCalendar>;
  /** Feed coverage, from calendar/calendar_dates. */
  feedStart: ServiceDate;
  feedEnd: ServiceDate;
}

export interface Leg {
  fromStop: string;
  fromName: string;
  toStop: string;
  toName: string;
  departure: ServiceTime;
  arrival: ServiceTime;
  routeName: string;
  headsign: string;
  tripId: string;
}

export interface Itinerary {
  destination: string;
  destinationName: string;
  lat: number;
  lon: number;
  departure: ServiceTime;
  arrival: ServiceTime;
  /** arrival - departure, in seconds, including waiting at interchanges. */
  duration: number;
  transfers: number;
  legs: Leg[];
}
