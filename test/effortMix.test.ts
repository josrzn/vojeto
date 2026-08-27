import { describe, expect, it } from "vitest";
import { shares } from "../web/src/EffortMix.js";
import { elapsedHours } from "../src/bike/effort.js";
import { gradeBand } from "../src/bike/profile.js";
import { TOURING_CURVE } from "../src/bike/speed.js";

const model = { curves: { paved: TOURING_CURVE, unpaved: TOURING_CURVE, unknown: TOURING_CURVE } };

/** Bands for a profile, the way the chart derives them. */
const bandsFor = (km: number[], ele: number[]) =>
  km.map((_, i) => {
    if (i === 0) return gradeBand(0);
    const run = (km[i]! - km[i - 1]!) * 1000;
    return gradeBand(run > 0 ? ((ele[i]! - ele[i - 1]!) / run) * 100 : 0);
  });

describe("shares", () => {
  it("sums to one", () => {
    const km = [0, 1, 2, 3, 4, 5];
    const ele = [0, 50, 40, 120, 60, 0];
    const mix = shares(bandsFor(km, ele), km);
    expect(mix.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("splits a there-and-back into equal halves of up and down", () => {
    // 5 km up at 4%, 5 km back down the same slope.
    const km = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ele = km.map((k) => (k <= 5 ? k * 40 : (10 - k) * 40));
    const mix = shares(bandsFor(km, ele), km);
    expect(mix[0]).toBeCloseTo(0.5, 6); // downhill
    expect(mix[3]).toBeCloseTo(0.5, 6); // 3–6%
    expect(mix[1]).toBe(0); // nothing flat
  });

  it("weighs the same ride differently by time than by distance", () => {
    // Half the distance climbing at 6%, half descending it. By distance that is
    // an even split; by time the climb is most of the afternoon.
    const km = Array.from({ length: 21 }, (_, i) => i);
    const ele = km.map((k) => (k <= 10 ? k * 60 : (20 - k) * 60));
    const bands = bandsFor(km, ele);

    const byDistance = shares(bands, km);
    const byTime = shares(bands, elapsedHours(km, ele, km.map(() => "paved" as const), model));

    expect(byDistance[0]).toBeCloseTo(0.5, 6);
    expect(byTime[0]!).toBeLessThan(0.2);
    expect(byTime[4]!).toBeGreaterThan(byDistance[4]!);
    expect(byTime.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it("ignores a band the ride never touches", () => {
    const km = [0, 1, 2];
    const mix = shares(bandsFor(km, [100, 100, 100]), km);
    expect(mix[1]).toBeCloseTo(1, 9);
    expect(mix.filter((s) => s > 0)).toHaveLength(1);
  });

  it("returns zeroes rather than dividing by nothing", () => {
    expect(shares([], []).every((s) => s === 0)).toBe(true);
    expect(shares([1], [0]).every((s) => s === 0)).toBe(true);
    // A profile with no length at all, which a degenerate route could produce.
    expect(shares([1, 1, 1], [0, 0, 0]).every((s) => s === 0)).toBe(true);
  });

  it("does not lose weight to a band index that does not exist", () => {
    // Defensive: a stray band number must not silently vanish from the total.
    const km = [0, 1, 2];
    const mix = shares([0, 99, 1], km);
    expect(mix.reduce((a, b) => a + b, 0)).toBeCloseTo(0.5, 9);
  });
});
