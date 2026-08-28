import { toDestination, type PlanDestination } from "../../src/build/destination.js";
import { haversine, type Point } from "../../src/shared/geo.js";
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
   * Stations the train reaches that fall outside the circle.
   *
   * Counted rather than listed: they are excluded by a straight line, which is
   * enough to leave a place off the map and not enough to say anything else
   * about it.
   */
  outOfRange: number;
}

/**
 * Itineraries as candidates, with the ones outside the circle dropped.
 *
 * The circle is the whole filter, and deliberately so: it is drawn before a
 * single road has been looked at, so a straight line is all it can honestly
 * be. A ride is never shorter than the crow flight, so nothing inside the
 * budget is ever outside a circle the budget drew — it admits places a real
 * road will not reach, which is the trade, and hides none that would have
 * worked. What is inside is a candidate; whether it is a trip is a question
 * for BRouter, asked one station at a time when you click one.
 */
export function explore(
  itineraries: Itinerary[],
  rideTo: Point,
  radiusKm: number,
): Exploration {
  const destinations: PlanDestination[] = [];
  let outOfRange = 0;

  for (const itinerary of itineraries) {
    if (!Number.isFinite(itinerary.lat) || !Number.isFinite(itinerary.lon)) continue;
    if (haversine(rideTo, itinerary) / 1000 > radiusKm) {
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
