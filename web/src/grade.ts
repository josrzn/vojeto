import { GRADE_BANDS, bandSeries, gradeBand } from "../../src/bike/profile.js";

/**
 * Gradient bands as an ordinal ramp: one hue, light to dark, so steepness is
 * legible as depth of colour rather than as a change of hue. Flat and downhill
 * take a recessive grey — they are not what costs you.
 *
 * Red, because the bike is the warm half of this map and the train the cool
 * one. Two steps are documented hexes; the ramp as a whole was run through the
 * ordinal checks (monotone lightness, step gaps, light-end contrast, single
 * hue) rather than picked by eye.
 */
export const GRADE_COLORS = ["#c3c2b7", "#f0a3a2", "#e66767", "#d03b3b", "#7d1c1c"] as const;

export const GRADE_LABELS = [
  "flat or down",
  `${GRADE_BANDS[0]}–${GRADE_BANDS[1]}%`,
  `${GRADE_BANDS[1]}–${GRADE_BANDS[2]}%`,
  `${GRADE_BANDS[2]}–${GRADE_BANDS[3]}%`,
  `${GRADE_BANDS[3]}%+`,
] as const;

export { gradeBand, bandSeries };

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
