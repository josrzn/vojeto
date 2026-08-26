import { haversine } from "../shared/geo.js";

/**
 * A route resampled at even distance, for the elevation profile and for
 * colouring the line by gradient.
 *
 * Even spacing is what the router's own output does not give: it emits a point
 * per OSM node, so gradients taken between consecutive points would be computed
 * over wildly different distances and would not be comparable.
 */
export interface RouteProfile {
  /** Metres between samples. */
  step: number;
  /** [lon, lat, elevation] at every step. */
  points: number[][];
}

/**
 * Gradient bands, in percent. Climbing is what costs you, so descent and the
 * flat share the recessive band and the rest step up by steepness.
 */
export const GRADE_BANDS = [1, 3, 6, 9] as const;

/** 0 for flat or downhill, then one band per threshold. */
export function gradeBand(percent: number): number {
  let band = 0;
  for (const threshold of GRADE_BANDS) if (percent >= threshold) band++;
  return band;
}

/** Distance along the track at each point, in metres. */
function cumulative(coordinates: number[][]): number[] {
  const totals = [0];
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1]!;
    const b = coordinates[i]!;
    totals.push(totals[i - 1]! + haversine({ lon: a[0]!, lat: a[1]! }, { lon: b[0]!, lat: b[1]! }));
  }
  return totals;
}

/**
 * Resamples a track at a fixed distance step, interpolating position and
 * elevation. Returns the original endpoints unchanged.
 */
export function resampleByDistance(coordinates: number[][], step: number): RouteProfile {
  if (step <= 0 || coordinates.length < 2) {
    return { step, points: coordinates.map((c) => [...c]) };
  }

  const totals = cumulative(coordinates);
  const length = totals.at(-1)!;
  const points: number[][] = [];
  let cursor = 0;

  for (let target = 0; target <= length; target += step) {
    while (cursor < totals.length - 2 && totals[cursor + 1]! < target) cursor++;
    const a = coordinates[cursor]!;
    const b = coordinates[cursor + 1]!;
    const span = totals[cursor + 1]! - totals[cursor]!;
    const t = span > 0 ? (target - totals[cursor]!) / span : 0;
    points.push([
      a[0]! + (b[0]! - a[0]!) * t,
      a[1]! + (b[1]! - a[1]!) * t,
      (a[2] ?? 0) + ((b[2] ?? 0) - (a[2] ?? 0)) * t,
    ]);
  }

  // Always finish exactly at the end rather than wherever the last step landed.
  const last = coordinates.at(-1)!;
  points.push([last[0]!, last[1]!, last[2] ?? 0]);
  return { step, points };
}

/**
 * Smooths the elevation series with a moving average.
 *
 * The elevations come from a ~30 m digital elevation model, so point-to-point
 * differences carry sampling noise that would show up as spurious steep pitches
 * once turned into gradients. Positions are untouched.
 */
export function smoothElevation(points: number[][], window: number): number[][] {
  if (window <= 1) return points;
  const half = Math.floor(window / 2);
  return points.map((point, i) => {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(points.length - 1, i + half); j++) {
      sum += points[j]![2] ?? 0;
      count++;
    }
    return [point[0]!, point[1]!, sum / count];
  });
}

/** Gradient in percent for the segment ending at each point; index 0 is 0. */
export function grades(profile: RouteProfile): number[] {
  const out = [0];
  for (let i = 1; i < profile.points.length; i++) {
    const a = profile.points[i - 1]!;
    const b = profile.points[i]!;
    const run = haversine({ lon: a[0]!, lat: a[1]! }, { lon: b[0]!, lat: b[1]! });
    out.push(run > 0 ? (((b[2] ?? 0) - (a[2] ?? 0)) / run) * 100 : 0);
  }
  return out;
}

/** Rounds for shipping: 5 decimals of position is ~1 m, elevation to the metre. */
export function compact(profile: RouteProfile): RouteProfile {
  return {
    step: profile.step,
    points: profile.points.map((p) => [
      Number(p[0]!.toFixed(5)),
      Number(p[1]!.toFixed(5)),
      Math.round(p[2] ?? 0),
    ]),
  };
}
