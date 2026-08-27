import { describe, expect, it } from "vitest";
import { hourTicks, indexAtFraction } from "../web/src/ElevationProfile.js";
import { elapsedHours, type EffortModel } from "../src/bike/effort.js";
import { TOURING_CURVE, curveFromLinearModel, speedAt } from "../src/bike/speed.js";

const everywhere = (curve: readonly { gradient: number; kmh: number }[]): EffortModel => ({
  curves: { paved: curve, unpaved: curve, unknown: curve },
});

const legacy: EffortModel = everywhere(curveFromLinearModel(16, 600));
const model: EffortModel = everywhere(TOURING_CURVE);

/** Every sample on the road, since these tests are about gradient. */
const paved = (n: number) => Array.from({ length: n }, () => "paved" as const);

describe("elapsedHours", () => {
  it("starts at zero and never goes backwards", () => {
    const km = [0, 1, 2, 3, 4];
    const ele = [200, 260, 240, 400, 100];
    const hours = elapsedHours(km, ele, paved(km.length), model);
    expect(hours[0]).toBe(0);
    for (let i = 1; i < hours.length; i++) expect(hours[i]!).toBeGreaterThan(hours[i - 1]!);
  });

  it("rides a segment at the curve's speed for its gradient", () => {
    // 10 km at a steady 5%: 500 m of climb over 10 km.
    const hours = elapsedHours([0, 10], [0, 500], paved(2), model).at(-1)!;
    expect(hours).toBeCloseTo(10 / speedAt(TOURING_CURVE, 5), 9);
  });

  it("goes faster downhill than on the flat", () => {
    const flat = elapsedHours([0, 16], [100, 100], paved(2), model).at(-1)!;
    const down = elapsedHours([0, 16], [700, 100], paved(2), model).at(-1)!;
    const up = elapsedHours([0, 16], [100, 700], paved(2), model).at(-1)!;
    expect(flat).toBeCloseTo(1, 6);
    expect(down).toBeLessThan(flat);
    expect(up).toBeGreaterThan(flat);
  });

  it("keeps the old model's numbers when the curve is derived from it", () => {
    // The old estimate for 16 km climbing 600 m: 1 h of distance, 1 h of climb.
    expect(elapsedHours([0, 16], [100, 700], paved(2), legacy).at(-1)!).toBeCloseTo(2, 1);
    // And it descends at the flat speed, because that model had no descending.
    expect(elapsedHours([0, 16], [700, 100], paved(2), legacy).at(-1)!).toBeCloseTo(1, 6);
  });

  it("charges a rolling road more than the flat road it averages to", () => {
    // Up 3% for a km then down 3% for a km ends where it started, but the climb
    // costs far more than the descent gives back. A model that only knew the
    // net change would call this flat.
    const rolling = elapsedHours([0, 1, 2], [0, 30, 0], paved(3), model).at(-1)!;
    const flat = elapsedHours([0, 2], [0, 0], paved(2), model).at(-1)!;
    expect(rolling).toBeGreaterThan(flat);
  });

  it("stretches a climb relative to distance", () => {
    // Two 5 km halves, the second one climbing. On a distance axis each takes
    // half the width; on a time axis the climb has to take more.
    const hours = elapsedHours([0, 5, 10], [0, 0, 300], paved(3), model);
    expect(hours[1]! / hours[2]!).toBeLessThan(0.5);
  });
});

describe("hourTicks", () => {
  it("keeps the count readable across ride lengths", () => {
    for (const total of [0.5, 1.2, 3, 5.5, 8, 12, 20, 31, 48]) {
      expect(hourTicks(total).length).toBeLessThanOrEqual(6);
    }
  });

  it("stays strictly inside the ride", () => {
    const ticks = hourTicks(5.5);
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThan(0);
      expect(tick).toBeLessThan(5.5);
    }
  });

  it("does not crowd a tick against the total", () => {
    // 6h exactly: a tick at 6 would print on top of the end label.
    expect(hourTicks(6)).not.toContain(6);
    // 3h30: a 3h tick lands close enough to "3h30" for the labels to touch.
    expect(hourTicks(3.5)).not.toContain(3);
    for (const total of [1.1, 2.4, 3.5, 4.9, 7.2, 9.9]) {
      const last = hourTicks(total).at(-1);
      if (last !== undefined) expect(total - last).toBeGreaterThan(total * 0.08);
    }
  });
});

describe("indexAtFraction", () => {
  const even = [0, 1, 2, 3, 4];

  it("picks the nearest sample on an evenly spaced domain", () => {
    expect(indexAtFraction(even, 0)).toBe(0);
    expect(indexAtFraction(even, 1)).toBe(4);
    expect(indexAtFraction(even, 0.5)).toBe(2);
    expect(indexAtFraction(even, 0.3)).toBe(1);
  });

  it("clamps outside the plot", () => {
    expect(indexAtFraction(even, -0.4)).toBe(0);
    expect(indexAtFraction(even, 1.8)).toBe(4);
  });

  it("follows an uneven domain, which is what a time axis is", () => {
    // Most of the time goes on the last stretch, so the middle of the chart is
    // an early sample, not the middle sample.
    const uneven = [0, 0.2, 0.4, 3, 6];
    expect(indexAtFraction(uneven, 0.5)).toBe(3);
    expect(indexAtFraction(uneven, 0.04)).toBe(1);
  });
});
