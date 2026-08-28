import type { Query } from "../../src/router/raptor.js";
import { toDestination, type PlanDestination } from "../../src/build/destination.js";
import { maxRideKm } from "../../src/bike/effort.js";
import { haversine, type Point } from "../../src/shared/geo.js";
import type { Budget, EffortModel } from "../../src/bike/effort.js";
import type { Itinerary } from "../../src/shared/types.js";

/** Where you are starting from and where the ride has to end. */
export interface Home {
  stationId: string;
  name: string;
  /** The station itself, for drawing and for measuring against. */
  at: Point;
  /** Your door, which is not the station. */
  rideTo: Point;
}

export interface Exploration {
  destinations: PlanDestination[];
  /**
   * Stations the train reaches that no ride home could cover in the time left.
   *
   * Counted rather than listed: they are excluded by a straight line, which is
   * enough to rule a place out and not enough to say anything else about it.
   */
  outOfRange: number;
}

/**
 * The query the planner runs, from settings the interface holds.
 *
 * One place, so that picking a station by hand asks exactly what `npm run plan`
 * asks. The alternative is two call sites that agree until someone changes a
 * default in one of them.
 */
export function queryFor(home: Home, date: number, settings: TripSettings): Query {
  return {
    date,
    origin: home.stationId,
    earliestDeparture: settings.earliestDeparture,
    arriveBy: settings.arriveBy,
    arriveNoEarlierThan: settings.arriveNoEarlierThan,
    maxTravelSeconds: settings.maxTravelSeconds,
    maxTransfers: settings.maxTransfers,
    minTransferSeconds: settings.minTransferSeconds,
    maxTransferSeconds: settings.maxTransferSeconds,
  };
}

export interface TripSettings {
  earliestDeparture: number;
  arriveBy: number;
  arriveNoEarlierThan: number;
  maxTravelSeconds: number;
  maxTransfers: number;
  minTransferSeconds: number;
  maxTransferSeconds: number;
}

/**
 * Itineraries as destinations, with the ones no ride could reach dropped.
 *
 * The same straight-line bound the planner uses before it calls BRouter: a ride
 * is never shorter than the crow flight, so a station further away than the
 * hours left could cover at any speed cannot work, and no routing is needed to
 * know it. It admits places a real road will not reach — that is the trade —
 * but it never hides one that would have worked.
 */
export function explore(
  itineraries: Itinerary[],
  rideTo: Point,
  budget: Budget,
  effort: EffortModel,
): Exploration {
  const destinations: PlanDestination[] = [];
  let outOfRange = 0;

  for (const itinerary of itineraries) {
    if (!Number.isFinite(itinerary.lat) || !Number.isFinite(itinerary.lon)) continue;
    const reach = maxRideKm(itinerary.duration / 3600, budget, effort);
    if (haversine(rideTo, itinerary) / 1000 > reach) {
      outOfRange++;
      continue;
    }
    destinations.push(toDestination(itinerary));
  }

  return { destinations, outOfRange };
}

/** Hours on the train to each station, keeping the quickest seen. */
export function quickestTrains(destinations: PlanDestination[]): Record<string, number> {
  const hours: Record<string, number> = {};
  for (const destination of destinations) {
    const seen = hours[destination.stationId];
    const theseHours = destination.travelMinutes / 60;
    if (seen === undefined || theseHours < seen) hours[destination.stationId] = theseHours;
  }
  return hours;
}

/**
 * Whether two homes are the same place.
 *
 * Positions are compared with a tolerance rather than exactly: a ride-to point
 * that came back from JSON at the last bit of a double is the same doorway as
 * the one that went in, and a metre either way is well inside what the router
 * would round off anyway.
 */
export function sameHome(a: Home | null, b: Home | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.stationId === b.stationId &&
    Math.abs(a.rideTo.lat - b.rideTo.lat) < 1e-5 &&
    Math.abs(a.rideTo.lon - b.rideTo.lon) < 1e-5
  );
}

/** Stations whose name contains every word typed, best matches first. */
export function searchStations<T extends { id: string; name: string }>(
  stations: T[],
  query: string,
  limit = 40,
): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return stations.slice(0, limit);

  const scored: Array<{ station: T; score: number }> = [];
  for (const station of stations) {
    const name = station.name.toLowerCase();
    if (!words.every((word) => name.includes(word))) continue;
    // A station whose name starts with what you typed is what you meant;
    // "Lyon" should not offer Bellegarde-sur-Valserine first for containing it.
    const first = words[0]!;
    scored.push({ station, score: name.startsWith(first) ? 0 : name.indexOf(first) });
    if (scored.length > limit * 8) break;
  }
  return scored
    .sort((a, b) => a.score - b.score || a.station.name.localeCompare(b.station.name, "fr"))
    .slice(0, limit)
    .map((s) => s.station);
}
