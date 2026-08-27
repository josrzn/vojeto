import { SURFACES, type Surface } from "./surface.js";

/**
 * How fast you ride, as a function of gradient.
 *
 * The obvious model — a flat speed plus a metres-per-hour climbing allowance —
 * is two numbers fitted to one gradient. Written out as a speed it says you go
 * exactly as fast down a 10% descent as along the flat, and that your rate of
 * climbing *rises* with steepness: 126 m/h at 1%, 480 m/h at 15%. Real riders
 * are the other way round. They hold a roughly constant vertical rate over the
 * gradients that matter and lose it on the very steep pitches, and they descend
 * two or three times faster than they cruise.
 *
 * So the model is a curve instead: a handful of gradient/speed anchors,
 * interpolated. There is no physics in it — no mass, no power, no drag — because
 * a rider can tell you what they do at 5% and cannot tell you their CdA. Every
 * number in it is a number you can check against your own legs.
 */
export interface SpeedAnchor {
  /** Gradient in percent. Negative is downhill. */
  gradient: number;
  /** Speed in km/h sustained at that gradient. */
  kmh: number;
}

export type SpeedCurve = readonly SpeedAnchor[];

/** One curve per surface: the whole speed model. */
export type SpeedCurves = Readonly<Record<Surface, SpeedCurve>>;

/**
 * A loaded tourer on mixed French back roads, as a starting point.
 *
 * Flat speed is 16 km/h, matching what this project used before. Uphill, the
 * anchors hold about 420 m/h of ascent between 5% and 10%, which is what a
 * constant effort actually looks like, and give way above that as the gearing
 * runs out. Downhill they peak around -6% and fall off again: a steep descent
 * on a loaded bike is ridden on the brakes, not faster.
 *
 * These are meant to be edited. `ride.speedByGradient` in the config replaces
 * them wholesale, and the honest way to set it is to look at your own rides.
 */
export const TOURING_CURVE: SpeedCurve = [
  { gradient: -20, kmh: 20 },
  { gradient: -14, kmh: 27 },
  { gradient: -9, kmh: 31 },
  { gradient: -6, kmh: 32 },
  { gradient: -4, kmh: 30 },
  { gradient: -2, kmh: 24 },
  { gradient: -1, kmh: 20 },
  { gradient: 0, kmh: 16 },
  { gradient: 1, kmh: 13 },
  { gradient: 2, kmh: 11 },
  { gradient: 3, kmh: 9.5 },
  { gradient: 4, kmh: 8.6 },
  { gradient: 5, kmh: 8 },
  { gradient: 6, kmh: 7 },
  { gradient: 8, kmh: 5.3 },
  { gradient: 10, kmh: 4.3 },
  { gradient: 12, kmh: 3.7 },
  { gradient: 15, kmh: 3.3 },
  { gradient: 20, kmh: 2.8 },
];

/**
 * The same rider on gravel, and the shape of the difference is the point.
 *
 * Loose surface costs you most where you were going fastest: the descent that
 * was 32 km/h on tarmac is 20 on gravel, because it is ridden on the brakes.
 * It costs you least on a steep climb, where 4 km/h is 4 km/h whatever is under
 * the tyre. A single "gravel is twenty percent slower" multiplier would flatten
 * exactly the structure worth seeing.
 */
export const GRAVEL_CURVE: SpeedCurve = [
  { gradient: -20, kmh: 11 },
  { gradient: -14, kmh: 14 },
  { gradient: -9, kmh: 18 },
  { gradient: -6, kmh: 20 },
  { gradient: -4, kmh: 19.5 },
  { gradient: -2, kmh: 16.5 },
  { gradient: -1, kmh: 15 },
  { gradient: 0, kmh: 13 },
  { gradient: 1, kmh: 11 },
  { gradient: 2, kmh: 9.6 },
  { gradient: 3, kmh: 8.5 },
  { gradient: 4, kmh: 7.8 },
  { gradient: 5, kmh: 7.2 },
  { gradient: 6, kmh: 6.4 },
  { gradient: 8, kmh: 5 },
  { gradient: 10, kmh: 4 },
  { gradient: 12, kmh: 3.5 },
  { gradient: 15, kmh: 3.1 },
  { gradient: 20, kmh: 2.6 },
];

/**
 * The default model: road speeds on anything surfaced, gravel speeds on
 * anything that is not, and road speeds where nobody has recorded which.
 *
 * `unknown` takes the optimistic curve on purpose. The pessimistic choice would
 * quietly inflate every duration in a region where OSM happens to be thinly
 * tagged, and a slow answer that is wrong for a reason you cannot see is worse
 * than a fast one you have been told to distrust — so the share of unrecorded
 * surface is reported instead of being priced in.
 */
export const TOURING_CURVES: SpeedCurves = {
  paved: TOURING_CURVE,
  unpaved: GRAVEL_CURVE,
  unknown: TOURING_CURVE,
};

/**
 * Speed at a gradient, interpolated between anchors and flat outside them.
 *
 * Holding the end values rather than extrapolating is deliberate: extrapolating
 * a straight line off either end reaches zero or negative speed within a few
 * percent, and a single bad elevation sample would then poison a whole ride.
 */
export function speedAt(curve: SpeedCurve, gradient: number): number {
  const first = curve[0]!;
  if (gradient <= first.gradient) return first.kmh;
  const last = curve[curve.length - 1]!;
  if (gradient >= last.gradient) return last.kmh;

  let lo = 0;
  let hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid]!.gradient <= gradient) lo = mid;
    else hi = mid;
  }
  const a = curve[lo]!;
  const b = curve[hi]!;
  const t = (gradient - a.gradient) / (b.gradient - a.gradient);
  return a.kmh + (b.kmh - a.kmh) * t;
}

/** Speed on a given surface at a given gradient. */
export function speedOn(curves: SpeedCurves, surface: Surface, gradient: number): number {
  return speedAt(curves[surface] ?? curves.paved, gradient);
}

/** Speed on the flat, which stands in for the curve wherever one number is wanted. */
export function flatKmh(curve: SpeedCurve): number {
  return speedAt(curve, 0);
}

/**
 * The fastest the model allows anywhere, used only for the pruning bound.
 *
 * Taken across every surface, since the bound must not exclude a destination
 * the router might reach on the quick one.
 */
export function fastestFlatKmh(curves: SpeedCurves): number {
  return Math.max(...SURFACES.map((surface) => flatKmh(curves[surface] ?? curves.paved)));
}

/**
 * The curve implied by the old flat-speed-plus-climbing-rate model, so a config
 * written before the curve existed still produces the numbers it used to.
 *
 * Exact at the anchors and interpolated between them, so it is an approximation
 * rather than a reproduction: worst case about half a percent — twenty seconds
 * on a four-hour ride — up to 12%, and under one percent beyond that. Anchors
 * are packed into the shallow gradients because that is where the old model
 * curves hardest and where roads actually are.
 */
export function curveFromLinearModel(speedKmh: number, climbMetresPerHour: number): SpeedCurve {
  const at = (gradient: number) => {
    if (gradient <= 0) return speedKmh;
    // Percent gradient g over one km climbs 10g metres, so an hour of riding
    // costs 1/speed + 10g/climbRate.
    return 1 / (1 / speedKmh + (10 * gradient) / climbMetresPerHour);
  };
  const gradients = [
    -30, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10, 12, 14,
    16, 20, 25, 30,
  ];
  return gradients.map((gradient) => ({ gradient, kmh: at(gradient) }));
}

/**
 * Checks a curve is usable before anything depends on it.
 *
 * Anchors out of order would make the interpolation search return nonsense, and
 * a zero or negative speed would make a ride take forever or finish before it
 * started — both worth catching where the config is read rather than three
 * hundred router requests later.
 */
export function validateCurve(curve: SpeedCurve, where: string): SpeedCurve {
  if (curve.length < 2) throw new Error(`${where}: needs at least two gradient/speed anchors`);
  for (let i = 0; i < curve.length; i++) {
    const { gradient, kmh } = curve[i]!;
    if (!Number.isFinite(gradient)) throw new Error(`${where}: gradient ${gradient} is not a number`);
    if (!Number.isFinite(kmh) || kmh <= 0) {
      throw new Error(`${where}: speed at ${gradient}% must be above zero, got ${kmh}`);
    }
    if (i > 0 && gradient <= curve[i - 1]!.gradient) {
      throw new Error(`${where}: gradients must increase, ${curve[i - 1]!.gradient} then ${gradient}`);
    }
  }
  if (curve[0]!.gradient > 0 || curve[curve.length - 1]!.gradient < 0) {
    throw new Error(`${where}: the anchors must span 0% so a flat speed is defined`);
  }
  return curve;
}

/** A few points off a curve, for the line of small print under the map. */
export function describeCurve(curve: SpeedCurve): string {
  const one = (gradient: number, suffix: string) =>
    `${Number(speedAt(curve, gradient).toFixed(1))} km/h ${suffix}`;
  return [one(0, "on the flat"), one(5, "at 5% up"), one(10, "at 10% up"), one(-5, "at 5% down")].join(
    ", ",
  );
}
