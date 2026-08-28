import { resampleByDistance, smoothElevation } from "../../src/bike/profile.js";
import { surfacesAlong } from "../../src/bike/surface.js";
import { haversine } from "../../src/shared/geo.js";
import type { BikeTrack } from "../../src/bike/track.js";
import { SURFACES, type LoadedProfile } from "./grade.js";

/**
 * The elevation chart's data, from wherever the ride came from.
 *
 * There are two sources — a profile the planner wrote to disk, and a track just
 * routed in the page — and exactly one way of turning either into a chart. That
 * matters more than it looks: the gradient bands, the mix bar and the timing all
 * read these arrays, so two nearly-identical derivations would eventually
 * disagree about the same road.
 */
export function profileFromPoints(points: number[][], surfaces?: number[]): LoadedProfile {
  const km: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    km.push(km[i - 1]! + haversine({ lon: p[0]!, lat: p[1]! }, { lon: q[0]!, lat: q[1]! }) / 1000);
  }
  const ele = points.map((p) => p[2] ?? 0);
  // A profile written before surfaces were shipped simply has none, and
  // "unknown" is exactly what that means.
  const surface = points.map((_, i) => SURFACES[surfaces?.[i] ?? -1] ?? "unknown");
  return { km, ele, grade: gradesOf(km, ele), surface, at: points.map((p) => [p[0]!, p[1]!]) };
}

/**
 * The same chart, for a ride routed here rather than read from a file.
 *
 * Resampled and smoothed exactly as `measureRide` does it, because the hours
 * shown under the chart come from that resampling: a chart drawn off the raw
 * router vertices would show pitches the timing never charged for.
 */
export function profileFromTrack(track: BikeTrack, stepMetres: number): LoadedProfile {
  const points = smoothElevation(resampleByDistance(track.coordinates, stepMetres).points, 3);
  const profile = profileFromPoints(points);
  return { ...profile, surface: [...surfacesAlong(track.ways, profile.km)] };
}

/** Gradient in percent for the segment ending at each sample. */
function gradesOf(km: number[], ele: number[]): number[] {
  const grade = [0];
  for (let i = 1; i < km.length; i++) {
    const run = (km[i]! - km[i - 1]!) * 1000;
    grade.push(run > 0 ? ((ele[i]! - ele[i - 1]!) / run) * 100 : 0);
  }
  return grade;
}
