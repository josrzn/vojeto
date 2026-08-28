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
 * The same scale as the map draws it, which is not the same colours.
 *
 * Two differences, both because a three-pixel line on a busy basemap is not a
 * filled region on white paper.
 *
 * Descent is folded back into the neutral. On the map the ride home often runs
 * within a few pixels of the train's equally thin blue line, and a cool stroke
 * there reads as a second railway however far apart the two colours measure —
 * the separation thresholds assume marks with some area to them. So the map
 * ramp is not diverging at all: it runs neutral to steep, one hue.
 *
 * And every step is darker. The chart's light end is a large area on white and
 * has all the contrast it needs; the same colour as a hairline over roads,
 * fields and towns disappears, and on a typical ride two thirds of the line is
 * that one step. These are stepped from the same red at a lower lightness:
 * monotone light to dark with a gap of at least 0.06 in OKLCH L between
 * neighbours, the lightest clearing 4.4:1 against open land and 5:1 against a
 * white road. The neutral was pushed darker still than legibility alone wanted,
 * to clear the green of the station dots under simulated deuteranopia — at the
 * green's own lightness the two collapse together, and 12.2 apart is the price
 * of the line and the dots never being confusable.
 *
 * The map's own key is drawn from these, so what it shows is what is on screen.
 */
export const MAP_GRADE_COLORS = [
  "#816a65",
  "#816a65",
  "#8a453d",
  "#861e1d",
  "#700110",
  "#52020d",
] as const;

/**
 * The surfaces, as their own small palette rather than more of the gradient ramp.
 *
 * Grey for made-up road, earth brown for what is not, and a pale hatch for what
 * nobody has recorded. They never share a bar with the gradient bands — the mix
 * bar shows one division or the other — so these only had to separate from each
 * other, which they do by 17, 32 and 17 under normal vision and by at least 16
 * under simulated protanopia and deuteranopia.
 *
 * Ink is legible on all three, so unlike the gradient ramp no segment needs
 * light text.
 */
export const SURFACE_COLORS: Record<Surface, string> = {
  paved: "#a4acb4",
  unpaved: "#b17834",
  unknown: "#dfe3e7",
};

export const SURFACE_LABELS: Record<Surface, string> = {
  paved: "road",
  unpaved: "unpaved",
  unknown: "unrecorded",
};

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
