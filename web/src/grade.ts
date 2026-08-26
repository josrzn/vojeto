import { GRADE_BANDS, gradeBand } from "../../src/bike/profile.js";

/**
 * Gradient bands as an ordinal ramp: one hue, light to dark, so steepness is
 * legible as depth of colour rather than as a change of hue. Flat and downhill
 * take a recessive grey — they are not what costs you.
 *
 * Steps are the documented blue ordinal ramp (250, 400, 500, 700), which clears
 * the monotone-lightness, step-gap, light-end contrast and single-hue checks.
 */
export const GRADE_COLORS = ["#c3c2b7", "#86b6ef", "#3987e5", "#256abf", "#0d366b"] as const;

export const GRADE_LABELS = [
  "flat or down",
  `${GRADE_BANDS[0]}–${GRADE_BANDS[1]}%`,
  `${GRADE_BANDS[1]}–${GRADE_BANDS[2]}%`,
  `${GRADE_BANDS[2]}–${GRADE_BANDS[3]}%`,
  `${GRADE_BANDS[3]}%+`,
] as const;

export { gradeBand };

export interface LoadedProfile {
  /** Cumulative distance in km at each sample. */
  km: number[];
  /** Elevation in metres at each sample. */
  ele: number[];
  /** Gradient in percent for the segment ending at each sample. */
  grade: number[];
  /** [lon, lat] at each sample. */
  at: number[][];
}
