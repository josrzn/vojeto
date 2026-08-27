import { describe, expect, it } from "vitest";
import {
  TOURING_CURVE,
  curveFromLinearModel,
  describeCurve,
  flatKmh,
  speedAt,
  validateCurve,
  type SpeedCurve,
} from "../src/bike/speed.js";

const simple: SpeedCurve = [
  { gradient: -5, kmh: 30 },
  { gradient: 0, kmh: 16 },
  { gradient: 5, kmh: 8 },
];

describe("speedAt", () => {
  it("returns the anchors exactly", () => {
    for (const anchor of simple) expect(speedAt(simple, anchor.gradient)).toBe(anchor.kmh);
  });

  it("interpolates between anchors", () => {
    expect(speedAt(simple, 2.5)).toBeCloseTo(12, 6);
    expect(speedAt(simple, -2.5)).toBeCloseTo(23, 6);
  });

  it("holds the end values rather than extrapolating", () => {
    // Extrapolating the top pair would reach zero at 10% and go negative after,
    // so a single bad elevation sample would stall a whole ride.
    expect(speedAt(simple, 12)).toBe(8);
    expect(speedAt(simple, 40)).toBe(8);
    expect(speedAt(simple, -40)).toBe(30);
  });

  it("finds the right interval on a long curve", () => {
    for (const anchor of TOURING_CURVE) {
      expect(speedAt(TOURING_CURVE, anchor.gradient)).toBe(anchor.kmh);
    }
    // And between every neighbouring pair, staying inside their two speeds.
    for (let i = 1; i < TOURING_CURVE.length; i++) {
      const a = TOURING_CURVE[i - 1]!;
      const b = TOURING_CURVE[i]!;
      const mid = speedAt(TOURING_CURVE, (a.gradient + b.gradient) / 2);
      expect(mid).toBeGreaterThanOrEqual(Math.min(a.kmh, b.kmh));
      expect(mid).toBeLessThanOrEqual(Math.max(a.kmh, b.kmh));
    }
  });
});

describe("the touring curve", () => {
  it("gets slower the steeper it gets, going up", () => {
    for (let g = 0; g < 20; g += 0.25) {
      expect(speedAt(TOURING_CURVE, g + 0.25)).toBeLessThanOrEqual(speedAt(TOURING_CURVE, g));
    }
  });

  it("descends faster than it rides the flat", () => {
    for (const g of [-1, -2, -4, -6, -9, -14, -20]) {
      expect(speedAt(TOURING_CURVE, g)).toBeGreaterThan(flatKmh(TOURING_CURVE));
    }
  });

  it("stops speeding up on a descent steep enough to brake down", () => {
    // The fastest point is somewhere mid-descent, not at the bottom of the
    // curve: a 20% drop on a loaded bike is ridden slower than a 6% one.
    expect(speedAt(TOURING_CURVE, -20)).toBeLessThan(speedAt(TOURING_CURVE, -6));
  });

  it("holds a roughly steady rate of climbing where the roads are", () => {
    // Metres of ascent per hour, which is the thing that stays put when a rider
    // holds an effort. The old model had this rising from 126 to 480.
    const vam = (g: number) => speedAt(TOURING_CURVE, g) * 1000 * (g / 100);
    const rates = [4, 5, 6, 8, 10].map(vam);
    expect(Math.min(...rates)).toBeGreaterThan(330);
    expect(Math.max(...rates) / Math.min(...rates)).toBeLessThan(1.35);
  });
});

describe("curveFromLinearModel", () => {
  it("has no descending in it, exactly as the old model had none", () => {
    const curve = curveFromLinearModel(16, 600);
    for (const g of [-1, -5, -12]) expect(speedAt(curve, g)).toBe(16);
  });

  it("reproduces the old speeds where they can be checked by hand", () => {
    const curve = curveFromLinearModel(16, 600);
    // 16 km/h flat plus 600 m/h of climb: one hour covers 8 km at 5%, since
    // 8 km at 5% is 400 m up — 0.5 h of distance and 0.67 h of climbing.
    expect(speedAt(curve, 0)).toBeCloseTo(16, 6);
    expect(speedAt(curve, 5)).toBeCloseTo(1 / (1 / 16 + 50 / 600), 6);
  });
});

describe("validateCurve", () => {
  const bad = (curve: unknown) => () => validateCurve(curve as SpeedCurve, "config");

  it("accepts a good curve", () => {
    expect(validateCurve(simple, "config")).toBe(simple);
  });

  it("refuses gradients out of order, which would break the lookup", () => {
    expect(bad([{ gradient: 5, kmh: 8 }, { gradient: 0, kmh: 16 }])).toThrow(/must increase/);
    expect(bad([{ gradient: 0, kmh: 16 }, { gradient: 0, kmh: 8 }])).toThrow(/must increase/);
  });

  it("refuses a speed of zero, which would make a ride take forever", () => {
    expect(bad([{ gradient: 0, kmh: 16 }, { gradient: 10, kmh: 0 }])).toThrow(/above zero/);
    expect(bad([{ gradient: 0, kmh: 16 }, { gradient: 10, kmh: -4 }])).toThrow(/above zero/);
  });

  it("refuses a curve that never says how fast the flat is", () => {
    expect(bad([{ gradient: 2, kmh: 11 }, { gradient: 5, kmh: 8 }])).toThrow(/span 0%/);
    expect(bad([{ gradient: -5, kmh: 30 }, { gradient: -2, kmh: 24 }])).toThrow(/span 0%/);
  });

  it("refuses a curve too short to interpolate", () => {
    expect(bad([{ gradient: 0, kmh: 16 }])).toThrow(/at least two/);
  });
});

describe("describeCurve", () => {
  it("reads as speeds a rider can check against their own legs", () => {
    expect(describeCurve(TOURING_CURVE)).toBe(
      "16 km/h on the flat, 8 km/h at 5% up, 4.3 km/h at 10% up, 31 km/h at 5% down",
    );
  });
});
