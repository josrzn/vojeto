import type { Itinerary } from "../shared/types.js";
import { formatDuration, formatTime } from "../gtfs/time.js";

/**
 * A trip as the interface shows it, from a trip as the router found it.
 *
 * Lives apart from the plan builder because both sides need it now: the builder
 * writes these into plan.json, and the browser makes them from a query it ran
 * itself. Two implementations would drift, and the drift would look like a
 * station changing its departure time when you picked it by hand instead of
 * finding it in the file.
 *
 * Nothing here touches the filesystem, so it can be bundled for the browser.
 */
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
  /** [lon, lat] of every stop this leg calls at, for drawing it on the map. */
  path: number[][];
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


export function toDestination(itinerary: Itinerary): PlanDestination {
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
      path: leg.calls.map((call) => [call.lon, call.lat]),
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
