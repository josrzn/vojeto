import { parseTrack, type BikeTrack } from "../../src/bike/track.js";
import { measureRide, type MeasureOptions, type RideVariant } from "../../src/bike/measure.js";
import type { PlanRideVariant } from "../../src/build/buildPlan.js";
import type { Point } from "../../src/shared/geo.js";

/**
 * Routing a ride home from the page.
 *
 * The planner does this over a disk cache with a one-second courtesy throttle,
 * which is the right shape for a script routing a hundred stations in a batch.
 * A page needs the same courtesy and a different shape: one route at a time, in
 * the order you are most likely to want them, cancellable the moment you move
 * the home again.
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

export interface Candidate {
  stationId: string;
  name: string;
  at: Point;
  trainHours: number;
  /** Straight-line km to the ride-to point, which decides the order. */
  crowKm: number;
}

export interface Progress {
  done: number;
  total: number;
  /** Stations that could not be routed at all, by name. */
  failed: string[];
}

/**
 * Routes every candidate, nearest first, reporting each as it lands.
 *
 * Nearest first because the closest station is both the likeliest to be
 * feasible and the likeliest to be the one you are about to click: the order
 * that fills the map from the middle outwards is also the order that answers
 * the question you already have.
 *
 * One profile per station, not six. The planner asks for every variant of every
 * ride because it has all night; here the first route is a filter — it says
 * whether this station is a trip at all — and the other ways home are worth
 * fetching only for the station you actually pick.
 */
export async function routeNearestFirst(
  candidates: Candidate[],
  rideTo: Point,
  spec: { id: string; label: string; profile: string },
  options: MeasureOptions & { baseUrl: string; throttleMs?: number },
  onRide: (stationId: string, variant: PlanRideVariant) => void,
  onProgress: (progress: Progress) => void,
  signal: AbortSignal,
): Promise<void> {
  const ordered = [...candidates].sort((a, b) => a.crowKm - b.crowKm);
  const failed: string[] = [];

  for (const [done, candidate] of ordered.entries()) {
    if (signal.aborted) return;
    onProgress({ done, total: ordered.length, failed: [...failed] });
    try {
      const track = await routeBike([candidate.at, rideTo], {
        baseUrl: options.baseUrl,
        profile: spec.profile,
        alternative: 0,
        ...(options.throttleMs !== undefined ? { throttleMs: options.throttleMs } : {}),
      }, signal);

      const measured = measureRide(track, [], spec, 0, {
        ...options,
        trainHours: candidate.trainHours,
      });
      onRide(candidate.stationId, asPlanVariant(measured));
    } catch (error) {
      // An abort is the home moving, not a failure: stop quietly.
      if (error instanceof DOMException && error.name === "AbortError") return;
      failed.push(candidate.name);
    }
  }
  onProgress({ done: ordered.length, total: ordered.length, failed });
}

/**
 * A measured ride in the shape the interface already reads.
 *
 * `track` and `surfaces` are dropped: in the file they become a .gpx and a
 * profile written to disk, and there is nowhere to write them here. The
 * elevation chart stays empty for a ride routed in the browser rather than
 * showing one belonging to a different road.
 */
function asPlanVariant(measured: Omit<RideVariant, "id" | "rank">): PlanRideVariant {
  const { track: _track, surfaces: _surfaces, ...rest } = measured;
  return { ...rest, id: measured.profile, rank: 1, gpx: null, elevationFile: null };
}
