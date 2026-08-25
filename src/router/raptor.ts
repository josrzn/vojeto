import type {
  Itinerary,
  Leg,
  Pattern,
  PatternTrip,
  ServiceDate,
  ServiceTime,
  TimetableIndex,
} from "../shared/types.js";
import { runsOn } from "../gtfs/calendar.js";

const INF = Number.MAX_SAFE_INTEGER;

export interface Query {
  date: ServiceDate;
  /** Station id, or the id of any stop within it. */
  origin: string;
  /** Do not consider trains leaving home before this. */
  earliestDeparture: ServiceTime;
  /** Must be off the train by this time. */
  arriveBy: ServiceTime;
  /** Arriving before this is pointless — nothing is open yet. */
  arriveNoEarlierThan: ServiceTime;
  maxTravelSeconds: number;
  maxTransfers: number;
  /** Shortest interchange you are willing to run for. */
  minTransferSeconds: number;
  /**
   * Longest you are willing to stand on a platform waiting.
   *
   * Without this a connection can technically exist but be useless: an hour
   * killed at 6am is not a trip you would actually take.
   */
  maxTransferSeconds: number;
}

/** A vehicle boarding, kept per (round, stop) so itineraries can be rebuilt. */
interface Boarding {
  pattern: number;
  trip: PatternTrip;
  boardPos: number;
  alightPos: number;
}

interface Round {
  arrival: Int32Array;
  /** Earliest time you can board here, i.e. arrival plus the interchange buffer. */
  readyAt: Float64Array;
  boarding: (Boarding | null)[];
  /** Stop this label was reached from on foot, when it came via a platform change. */
  transferFrom: Int32Array;
}

/**
 * Which trips of each pattern run on `date`, in departure order.
 * Recomputed per date and shared by every departure-time run.
 */
function activeTripsByPattern(index: TimetableIndex, date: ServiceDate): PatternTrip[][] {
  const cache = new Map<string, boolean>();
  const isActive = (serviceId: string): boolean => {
    let active = cache.get(serviceId);
    if (active === undefined) {
      const calendar = index.services.get(serviceId);
      active = calendar ? runsOn(calendar, date) : false;
      cache.set(serviceId, active);
    }
    return active;
  };
  return index.patterns.map((pattern) => pattern.trips.filter((t) => isActive(t.serviceId)));
}

/** Index of the first trip departing position `pos` no earlier than `time`, or -1. */
function earliestTripFrom(trips: PatternTrip[], pos: number, time: number): number {
  let low = 0;
  let high = trips.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (trips[mid]!.times[pos * 2 + 1]! < time) low = mid + 1;
    else high = mid;
  }
  return low < trips.length ? low : -1;
}

function newRound(stopCount: number): Round {
  return {
    arrival: new Int32Array(stopCount).fill(-1),
    readyAt: new Float64Array(stopCount).fill(INF),
    boarding: new Array<Boarding | null>(stopCount).fill(null),
    transferFrom: new Int32Array(stopCount).fill(-1),
  };
}

/**
 * One earliest-arrival RAPTOR run pinned to a single departure time.
 *
 * `arriveBy` is used for target pruning, which is what keeps this cheap enough
 * to run once per morning departure.
 */
function runRaptor(
  index: TimetableIndex,
  active: PatternTrip[][],
  originStops: number[],
  departure: ServiceTime,
  query: Query,
): Round[] {
  const stopCount = index.stops.length;
  const bestArrival = new Int32Array(stopCount).fill(-1);
  const rounds: Round[] = [newRound(stopCount)];
  const start = rounds[0]!;

  let marked = new Set<number>();
  for (const stop of originStops) {
    start.arrival[stop] = departure;
    // No interchange buffer on the first boarding: you are already on the platform.
    start.readyAt[stop] = departure;
    bestArrival[stop] = departure;
    marked.add(stop);
  }

  const deadline = Math.min(query.arriveBy, departure + query.maxTravelSeconds);

  for (let k = 1; k <= query.maxTransfers + 1 && marked.size > 0; k++) {
    const previous = rounds[k - 1]!;
    const current = newRound(stopCount);
    current.arrival.set(previous.arrival);
    current.readyAt.set(previous.readyAt);
    current.boarding = previous.boarding.slice();
    current.transferFrom.set(previous.transferFrom);
    rounds.push(current);

    // Earliest position at which each candidate pattern must be re-scanned.
    const queue = new Map<number, number>();
    for (const stop of marked) {
      for (const patternId of index.patternsAtStop[stop]!) {
        const pattern = index.patterns[patternId]!;
        const position = pattern.stops.indexOf(stop);
        const existing = queue.get(patternId);
        if (existing === undefined || position < existing) queue.set(patternId, position);
      }
    }

    const nextMarked = new Set<number>();
    for (const [patternId, from] of queue) {
      const pattern = index.patterns[patternId]!;
      const trips = active[patternId]!;
      if (trips.length === 0) continue;

      let tripIndex = -1;
      let boardPos = -1;

      for (let pos = from; pos < pattern.stops.length; pos++) {
        const stop = pattern.stops[pos]!;

        if (tripIndex >= 0) {
          const trip = trips[tripIndex]!;
          const arrival = trip.times[pos * 2]!;
          if (arrival <= deadline && (bestArrival[stop] === -1 || arrival < bestArrival[stop]!)) {
            bestArrival[stop] = arrival;
            current.arrival[stop] = arrival;
            current.readyAt[stop] = arrival + query.minTransferSeconds;
            current.boarding[stop] = { pattern: patternId, trip, boardPos, alightPos: pos };
            current.transferFrom[stop] = -1;
            nextMarked.add(stop);
          }
        }

        // Can we catch an earlier trip here than the one we are riding?
        const ready = previous.readyAt[stop]!;
        if (ready === INF) continue;
        const currentDeparture = tripIndex >= 0 ? trips[tripIndex]!.times[pos * 2 + 1]! : INF;
        if (ready > currentDeparture) continue;
        const candidate = earliestTripFrom(trips, pos, ready);
        if (candidate < 0 || (tripIndex !== -1 && candidate >= tripIndex)) continue;
        // The earliest catchable trip is also the shortest wait, so if even
        // that one leaves too late, no trip here makes a usable connection.
        const latestUseful = previous.arrival[stop]! + query.maxTransferSeconds;
        if (trips[candidate]!.times[pos * 2 + 1]! > latestUseful) continue;
        tripIndex = candidate;
        boardPos = pos;
      }
    }

    // Platform changes within a station, so an interchange can use a different track.
    for (const stop of [...nextMarked]) {
      const arrival = current.arrival[stop]!;
      for (const sibling of index.stopsInStation.get(index.stops[stop]!.station) ?? []) {
        if (sibling === stop) continue;
        const ready = arrival + query.minTransferSeconds;
        if (ready >= current.readyAt[sibling]!) continue;
        current.readyAt[sibling] = ready;
        if (current.arrival[sibling] === -1 || arrival < current.arrival[sibling]!) {
          current.arrival[sibling] = arrival;
          current.boarding[sibling] = null;
          current.transferFrom[sibling] = stop;
        }
        nextMarked.add(sibling);
      }
    }

    marked = nextMarked;
  }

  return rounds;
}

function buildItinerary(
  index: TimetableIndex,
  rounds: Round[],
  round: number,
  destination: number,
  originStops: Set<number>,
): Itinerary | null {
  const legs: Leg[] = [];
  let stop = destination;
  let k = round;

  for (let guard = 0; guard < 32; guard++) {
    if (originStops.has(stop)) break;
    const label = rounds[k]!;
    const boarding = label.boarding[stop];
    if (!boarding) {
      const from = label.transferFrom[stop]!;
      if (from < 0) return null;
      stop = from;
      continue;
    }
    const pattern = index.patterns[boarding.pattern]!;
    const boardStop = pattern.stops[boarding.boardPos]!;
    legs.push({
      fromStop: index.stops[boardStop]!.id,
      fromName: index.stops[boardStop]!.name,
      toStop: index.stops[stop]!.id,
      toName: index.stops[stop]!.name,
      departure: boarding.trip.times[boarding.boardPos * 2 + 1]!,
      arrival: boarding.trip.times[boarding.alightPos * 2]!,
      routeName: boarding.trip.routeName,
      headsign: boarding.trip.headsign,
      tripId: boarding.trip.tripId,
    });
    stop = boardStop;
    k--;
    if (k < 0) return null;
  }

  if (legs.length === 0) return null;
  legs.reverse();

  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  const target = index.stops[destination]!;
  return {
    destination: target.station,
    destinationName: target.name,
    lat: target.lat,
    lon: target.lon,
    departure: first.departure,
    arrival: last.arrival,
    duration: last.arrival - first.departure,
    transfers: legs.length - 1,
    legs,
  };
}

/** Every departure from the origin station, on `date`, inside the query window. */
function originDepartures(
  index: TimetableIndex,
  active: PatternTrip[][],
  originStops: number[],
  query: Query,
): ServiceTime[] {
  const times = new Set<ServiceTime>();
  for (const stop of originStops) {
    for (const patternId of index.patternsAtStop[stop]!) {
      const pattern: Pattern = index.patterns[patternId]!;
      for (let pos = 0; pos < pattern.stops.length - 1; pos++) {
        if (pattern.stops[pos] !== stop) continue;
        for (const trip of active[patternId]!) {
          const departure = trip.times[pos * 2 + 1]!;
          if (departure >= query.earliestDeparture && departure <= query.arriveBy) {
            times.add(departure);
          }
        }
      }
    }
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * Every station you can reach from home in time to be off the train by
 * `arriveBy`, with the best itinerary for each.
 *
 * "Best" is the shortest time on the move; ties go to the latest departure,
 * because a later start beats an earlier one for the same journey.
 */
export function reachableStations(index: TimetableIndex, query: Query): Itinerary[] {
  const originStops =
    index.stopsInStation.get(query.origin) ??
    (index.stopIndex.has(query.origin) ? [index.stopIndex.get(query.origin)!] : []);
  if (originStops.length === 0) {
    throw new Error(`Origin ${query.origin} is not served by any kept route`);
  }
  const originSet = new Set(originStops);

  const active = activeTripsByPattern(index, query.date);
  const departures = originDepartures(index, active, originStops, query);

  const best = new Map<string, Itinerary>();
  for (const departure of departures) {
    const rounds = runRaptor(index, active, originStops, departure, query);

    for (let stop = 0; stop < index.stops.length; stop++) {
      if (originSet.has(stop)) continue;
      for (let k = 1; k < rounds.length; k++) {
        const arrival = rounds[k]!.arrival[stop]!;
        if (arrival < 0) continue;
        if (arrival > query.arriveBy || arrival < query.arriveNoEarlierThan) continue;
        // Reached in an earlier round means the same or better with fewer legs.
        if (k > 1 && rounds[k - 1]!.arrival[stop] === arrival) continue;

        const itinerary = buildItinerary(index, rounds, k, stop, originSet);
        if (!itinerary) continue;
        if (itinerary.duration > query.maxTravelSeconds) continue;

        const previous = best.get(itinerary.destination);
        if (!previous || isBetter(itinerary, previous)) best.set(itinerary.destination, itinerary);
      }
    }
  }

  return [...best.values()].sort((a, b) => a.duration - b.duration);
}

function isBetter(candidate: Itinerary, incumbent: Itinerary): boolean {
  if (candidate.duration !== incumbent.duration) return candidate.duration < incumbent.duration;
  if (candidate.transfers !== incumbent.transfers) return candidate.transfers < incumbent.transfers;
  return candidate.departure > incumbent.departure;
}
