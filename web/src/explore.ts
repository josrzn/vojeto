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
   * Stations the train reaches that fall outside the circle, nearest first.
   *
   * Listed rather than counted. The circle is a guess, and a guess that hides
   * things has to show what it hid — otherwise the only way to discover that
   * Brest was one kilometre outside your radius is to widen it at random and
   * see what appears.
   */
  outside: Excluded[];
}

/** A station the circle left out, and by how much. */
export interface Excluded {
  stationId: string;
  name: string;
  /** Straight-line distance from the door, in km. */
  km: number;
  travelMinutes: number;
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
  const outside: Excluded[] = [];
  const seen = new Set<string>();

  for (const itinerary of itineraries) {
    if (!Number.isFinite(itinerary.lat) || !Number.isFinite(itinerary.lon)) continue;
    const km = haversine(rideTo, itinerary) / 1000;
    if (km > radiusKm) {
      // One entry per station: the same place reached twice is one place you
      // are not being shown, not two.
      if (seen.has(itinerary.destination)) continue;
      seen.add(itinerary.destination);
      outside.push({
        stationId: itinerary.destination,
        name: itinerary.destinationName,
        km,
        travelMinutes: Math.round(itinerary.duration / 60),
      });
      continue;
    }
    destinations.push(toDestination(itinerary));
  }

  outside.sort((a, b) => a.km - b.km);
  return { destinations, outside };
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
