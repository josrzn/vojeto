import { DOWNHILL_BAND, GRADE_BANDS, bandSeries, gradeBand } from "../../src/bike/profile.js";
import { SURFACES, type Surface } from "../../src/bike/surface.js";

/**
 * Gradient as a diverging scale: climbing on the warm arm, descending on the
 * cool one, flat as the neutral grey between them. Steepness reads as depth of
 * colour within an arm, so the order is visible without consulting the key.
 *
 * Red for the climbing arm, because the bike is the warm half of this map and
 * the train the cool one. The descent step is a muted teal rather than a blue:
 * the ride line and the train line are both lines on the same map, and blue is
 * the train's.
 *
 * Nothing here was picked by eye. The climbing arm passes the ordinal checks —
 * monotone lightness, adjacent lightness gaps, light-end contrast on the page,
 * single hue. Every pair that touches was measured for separation under normal
 * vision and under simulated protanopia and deuteranopia: descent against flat,
 * flat against the first climbing step, and the descent step against both the
 * train blue and the contour green it shares the map with.
 */
export const GRADE_COLORS = [
  "#51a7b6",
  "#c3c2b7",
  "#e8837f",
  "#df6463",
  "#cc373f",
  "#811d22",
] as const;

export const GRADE_LABELS = [
  "downhill",
  "flat",
  `${GRADE_BANDS[0]}–${GRADE_BANDS[1]}%`,
  `${GRADE_BANDS[1]}–${GRADE_BANDS[2]}%`,
  `${GRADE_BANDS[2]}–${GRADE_BANDS[3]}%`,
  `${GRADE_BANDS[3]}%+`,
] as const;

/**
 * The ramp as the map draws it, with descent folded back into the flat grey.
 *
 * On the map the ride home is a thin stroke, often running within a few pixels
 * of the train's equally thin blue one, and a cool stroke there reads as a
 * second railway however far apart the two colours measure — the separation
 * thresholds assume marks with some area to them. In the profile the same
 * colour is a large filled region with nothing blue anywhere near it, so it
 * stays. The two surfaces carry their own keys, so neither contradicts itself.
 */
export const MAP_GRADE_COLORS = GRADE_COLORS.map((color, band) =>
  band === 0 ? GRADE_COLORS[1] : color,
);

/** Bands dark enough that a label sitting on one has to be light. */
export const DARK_BANDS = new Set([4, 5]);

export { DOWNHILL_BAND };

export { gradeBand, bandSeries, SURFACES };
export type { Surface };

export interface LoadedProfile {
  /** What each sample is riding on, "unknown" where nobody has recorded it. */
  surface: Surface[];
  /** Cumulative distance in km at each sample. */
  km: number[];
  /** Elevation in metres at each sample. */
  ele: number[];
  /** Gradient in percent for the segment ending at each sample. */
  grade: number[];
  /** [lon, lat] at each sample. */
  at: number[][];
}
