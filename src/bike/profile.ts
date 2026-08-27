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

/**
 * The band for each sample, as something you can actually look at.
 *
 * Banding the raw per-sample gradient produces noise, not information: where
 * the gradient hovers near a threshold, consecutive samples fall either side of
 * it and the chart fills with alternating stripes across ground that rides as
 * one continuous slope. Two things fix that, and both are about honesty rather
 * than tidiness — a hundred-metre sample is simply too short to answer "is this
 * a climb":
 *
 * - the gradient is averaged over `window` samples before banding, so the band
 *   describes a stretch of road rather than one step;
 * - runs shorter than `minRun` are absorbed into what precedes them, so a
 *   momentary excursion over a threshold does not become a stripe.
 */
export function bandSeries(
  grades: number[],
  { window = 5, minRun = 3 }: { window?: number; minRun?: number } = {},
): number[] {
  if (grades.length === 0) return [];

  const half = Math.floor(window / 2);
  const bands = grades.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(grades.length - 1, i + half); j++) {
      sum += grades[j]!;
      count++;
    }
    return gradeBand(sum / count);
  });

  // Merge away runs too short to be worth a colour change. Done on the runs
  // themselves rather than by walking the samples: a single forward pass is
  // order-dependent and leaves stripes behind when every run is short, which is
  // exactly the case this exists to handle.
  interface Run {
    band: number;
    length: number;
  }
  const runs: Run[] = [];
  for (const band of bands) {
    const last = runs.at(-1);
    if (last && last.band === band) last.length++;
    else runs.push({ band, length: 1 });
  }

  for (;;) {
    if (runs.length < 2) break;
    let shortest = -1;
    for (let i = 0; i < runs.length; i++) {
      if (runs[i]!.length >= minRun) continue;
      if (shortest < 0 || runs[i]!.length < runs[shortest]!.length) shortest = i;
    }
    if (shortest < 0) break;

    // Fold into whichever neighbour is the more established.
    const before = runs[shortest - 1];
    const after = runs[shortest + 1];
    const into = !before ? after! : !after ? before : after.length > before.length ? after : before;
    into.length += runs[shortest]!.length;
    runs.splice(shortest, 1);

    // The splice may have brought two runs of the same band together.
    for (let i = runs.length - 1; i > 0; i--) {
      if (runs[i]!.band !== runs[i - 1]!.band) continue;
      runs[i - 1]!.length += runs[i]!.length;
      runs.splice(i, 1);
    }
  }

  const out: number[] = [];
  for (const run of runs) for (let i = 0; i < run.length; i++) out.push(run.band);
  return out;
}

/**
 * Rounds for shipping: 5 decimals of position is about a metre.
 *
 * Elevation keeps a decimal, which looks like more precision than a
 * thirty-metre model can support and is not there for precision. Speed depends
 * on gradient, and a gradient over a hundred-metre step is the difference of
 * two elevations: round those to the metre and the gradient moves in jumps of
 * a whole percent. The jumps are symmetric but the speed curve is not, so a
 * ride slows by about two thirds of a percent — small, but a bias rather than
 * noise, and it would land on the browser's numbers alone.
 */
export function compact(profile: RouteProfile): RouteProfile {
  return {
    step: profile.step,
    points: profile.points.map((p) => [
      Number(p[0]!.toFixed(5)),
      Number(p[1]!.toFixed(5)),
      Number((p[2] ?? 0).toFixed(1)),
    ]),
  };
}
