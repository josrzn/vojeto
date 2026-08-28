import { parseTrack, type BikeTrack } from "../../src/bike/track.js";
import { measureRide, type MeasureOptions, type RideVariant } from "../../src/bike/measure.js";
import type { PlanRideVariant } from "../../src/build/buildPlan.js";
import type { RouteStyle } from "./routeStyles.js";
import { profileFromTrack } from "./rideProfile.js";
import type { LoadedProfile } from "./grade.js";
import type { Point } from "../../src/shared/geo.js";

/**
 * Routing a ride home from the page.
 *
 * The planner does this over a disk cache with a one-second courtesy throttle,
 * which is the right shape for a script routing a hundred stations in a batch.
 * A page needs the same courtesy and a different shape: the ride you asked for,
 * now, and nothing you did not ask for. Clicking a station is one request;
 * asking for the other ways home is one more each.
 */
export interface RouterOptions {
  baseUrl: string;
  profile: string;
  alternative?: number;
  /** Pause between requests. brouter.de is donated hardware. */
  throttleMs?: number;
}

let lastRequestAt = 0;

/** One route, from a station back to your door. */
export async function routeBike(
  waypoints: Point[],
  options: RouterOptions,
  signal?: AbortSignal,
): Promise<BikeTrack> {
  const lonlats = waypoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join("|");
  const url =
    `${options.baseUrl}?lonlats=${encodeURIComponent(lonlats)}` +
    `&profile=${encodeURIComponent(options.profile)}` +
    `&alternativeidx=${options.alternative ?? 0}&format=geojson`;

  const throttleMs = options.throttleMs ?? 1000;
  const wait = lastRequestAt + throttleMs - Date.now();
  if (wait > 0) await sleep(wait, signal);
  lastRequestAt = Date.now();

  const response = await fetch(url, { signal: signal ?? null });
  const body = await response.text();
  if (!response.ok) throw new Error(`BRouter ${response.status}: ${body.slice(0, 200)}`);
  return parseTrack(body);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/** One way home from one station: what a click asks for. */
export interface RideRequest {
  /** The station you would be getting off at. */
  from: Point;
  /** Your door. */
  rideTo: Point;
  style: RouteStyle;
  /** Hours already spent on the train, which come out of the day. */
  trainHours: number;
}

export type RouteOptions = MeasureOptions & { baseUrl: string; throttleMs?: number };

/** A ride and its chart, which are made from the same track and arrive together. */
export interface RoutedRide {
  variant: PlanRideVariant;
  profile: LoadedProfile;
  /** Kept so the ride can be exported without asking for it a second time. */
  track: BikeTrack;
}

/**
 * Routes and measures one way home.
 *
 * Deliberately the smallest unit the interface can ask for. Everything the app
 * shows about a ride — its length, its climbing, its gradient mix, its hours,
 * whether it fits the day — comes out of this one call, so the page can stay
 * empty of guesses until you point at a station.
 */
export async function routeRide(
  request: RideRequest,
  options: RouteOptions,
  signal?: AbortSignal,
): Promise<RoutedRide> {
  const track = await routeBike(
    [request.from, request.rideTo],
    {
      baseUrl: options.baseUrl,
      profile: request.style.profile,
      alternative: 0,
      ...(options.throttleMs !== undefined ? { throttleMs: options.throttleMs } : {}),
    },
    signal,
  );

  const measured = measureRide(track, [], request.style, 0, {
    ...options,
    trainHours: request.trainHours,
  });
  return {
    variant: asPlanVariant(measured, request.style),
    profile: profileFromTrack(track, options.profileStepMetres),
    track,
  };
}

/**
 * A measured ride in the shape the interface already reads.
 *
 * `track` and `surfaces` are dropped: in the file they become a .gpx and a
 * profile written to disk, and there is nowhere to write them here. The
 * elevation chart is fed from the track this call returned instead, so it is
 * always the road on screen rather than one belonging to a different door.
 */
export function asPlanVariant(
  measured: Omit<RideVariant, "id" | "rank">,
  style: RouteStyle,
): PlanRideVariant {
  const { track: _track, surfaces: _surfaces, ...rest } = measured;
  return { ...rest, id: style.id, label: style.label, rank: 1, gpx: null, elevationFile: null };
}

