import { describe, expect, it } from "vitest";
import {
  bandSeries,
  compact,
  gradeBand,
  grades,
  resampleByDistance,
  smoothElevation,
} from "../src/bike/profile.js";
import { haversine } from "../src/shared/geo.js";

/** A straight run north, climbing steadily: about 2.2 km, 200 m to 300 m. */
const climb = [
  [4.0, 46.0, 200],
  [4.0, 46.01, 250],
  [4.0, 46.02, 300],
];

describe("resampleByDistance", () => {
  it("spaces samples evenly along the track", () => {
    const { points } = resampleByDistance(climb, 100);
    for (let i = 1; i < points.length - 1; i++) {
      const step = haversine(
        { lon: points[i - 1]![0]!, lat: points[i - 1]![1]! },
        { lon: points[i]![0]!, lat: points[i]![1]! },
      );
      expect(step).toBeCloseTo(100, 0);
    }
  });

  it("keeps the first and last point exactly", () => {
    const { points } = resampleByDistance(climb, 100);
    expect(points[0]).toEqual(climb[0]);
    expect(points.at(-1)).toEqual(climb.at(-1));
  });

  it("interpolates elevation between the source points", () => {
    const { points } = resampleByDistance(climb, 100);
    // Elevation rises monotonically because the source does.
    for (let i = 1; i < points.length; i++) {
      expect(points[i]![2]!).toBeGreaterThanOrEqual(points[i - 1]![2]! - 1e-9);
    }
    expect(points.at(-1)![2]).toBe(300);
  });

  it("preserves the overall length", () => {
    const { points } = resampleByDistance(climb, 100);
    let resampled = 0;
    for (let i = 1; i < points.length; i++) {
      resampled += haversine(
        { lon: points[i - 1]![0]!, lat: points[i - 1]![1]! },
        { lon: points[i]![0]!, lat: points[i]![1]! },
      );
    }
    let original = 0;
    for (let i = 1; i < climb.length; i++) {
      original += haversine(
        { lon: climb[i - 1]![0]!, lat: climb[i - 1]![1]! },
        { lon: climb[i]![0]!, lat: climb[i]![1]! },
      );
    }
    expect(resampled).toBeCloseTo(original, 0);
  });

  it("passes through degenerate input", () => {
    expect(resampleByDistance([], 100).points).toEqual([]);
    expect(resampleByDistance([[4, 46, 1]], 100).points).toEqual([[4, 46, 1]]);
    expect(resampleByDistance(climb, 0).points).toEqual(climb);
  });
});

describe("gradeBand", () => {
  it("puts flat and downhill in the recessive band", () => {
    expect(gradeBand(-12)).toBe(0);
    expect(gradeBand(0)).toBe(0);
    expect(gradeBand(0.9)).toBe(0);
  });

  it("steps up with steepness", () => {
    expect(gradeBand(1)).toBe(1);
    expect(gradeBand(2.9)).toBe(1);
    expect(gradeBand(3)).toBe(2);
    expect(gradeBand(6)).toBe(3);
    expect(gradeBand(9)).toBe(4);
    expect(gradeBand(20)).toBe(4);
  });

  it("never skips a band as the gradient rises", () => {
    let previous = 0;
    for (let g = -5; g <= 15; g += 0.25) {
      const band = gradeBand(g);
      expect(band - previous).toBeLessThanOrEqual(1);
      expect(band).toBeGreaterThanOrEqual(previous);
      previous = band;
    }
  });
});

describe("grades", () => {
  it("measures a steady climb", () => {
    // 100 m up over 2.2 km is a shade over 4.5%.
    const profile = resampleByDistance(climb, 100);
    const all = grades(profile).slice(1);
    for (const g of all) expect(g).toBeCloseTo(4.5, 0);
  });

  it("reports descent as negative", () => {
    const descent = [...climb].reverse();
    const all = grades(resampleByDistance(descent, 100)).slice(1);
    for (const g of all) expect(g).toBeLessThan(0);
  });

  it("starts at zero, having nothing to compare against", () => {
    expect(grades(resampleByDistance(climb, 100))[0]).toBe(0);
  });
});

describe("smoothElevation", () => {
  it("damps a single-point spike without moving the position", () => {
    const spiky = [
      [4.0, 46.0, 200],
      [4.0, 46.001, 260], // a 60 m spike the elevation model invented
      [4.0, 46.002, 200],
    ];
    const smoothed = smoothElevation(spiky, 3);
    expect(smoothed[1]![2]!).toBeLessThan(260);
    expect(smoothed[1]![0]).toBe(4.0);
    expect(smoothed[1]![1]).toBe(46.001);
  });

  it("leaves a steady climb essentially alone", () => {
    const steady = [
      [4.0, 46.0, 100],
      [4.0, 46.001, 110],
      [4.0, 46.002, 120],
      [4.0, 46.003, 130],
      [4.0, 46.004, 140],
    ];
    expect(smoothElevation(steady, 3)[2]![2]).toBeCloseTo(120, 6);
  });

  it("does nothing for a window of one", () => {
    expect(smoothElevation(climb, 1)).toEqual(climb);
  });
});

describe("compact", () => {
  it("rounds to about a metre of position and a tenth of one of height", () => {
    const { points } = compact({ step: 100, points: [[4.123456789, 46.987654321, 210.44]] });
    expect(points[0]).toEqual([4.12346, 46.98765, 210.4]);
  });

  it("keeps enough height precision that gradients do not move in whole percent", () => {
    // A hundred-metre step rising 0.34 m is a 0.34% gradient. Rounded to the
    // metre it is either 0% or 1%, and the speed curve charges differently for
    // those; a tenth of a metre keeps it inside a tenth of a percent.
    const { points } = compact({ step: 100, points: [[0, 0, 100], [0, 0, 100.34]] });
    const gradient = ((points[1]![2]! - points[0]![2]!) / 100) * 100;
    expect(Math.abs(gradient - 0.34)).toBeLessThan(0.1);
  });
});

describe("bandSeries", () => {
  it("does not stripe a slope that merely wobbles across a threshold", () => {
    // Hovering either side of 1%: raw banding alternates on every sample.
    const wobble = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.9 : 1.1));
    const raw = wobble.map(gradeBand);
    expect(new Set(raw).size).toBe(2);

    const bands = bandSeries(wobble);
    expect(new Set(bands).size).toBe(1);
  });

  it("still reports a climb that genuinely persists", () => {
    const grades = [...Array(20).fill(0), ...Array(20).fill(7)];
    const bands = bandSeries(grades);
    expect(bands[2]).toBe(0);
    expect(bands.at(-1)).toBe(3);
  });

  it("absorbs a brief excursion but not a sustained one", () => {
    const brief = [...Array(20).fill(0), 8, 8, ...Array(20).fill(0)];
    expect(new Set(bandSeries(brief, { window: 1, minRun: 4 })).size).toBe(1);

    const sustained = [...Array(20).fill(0), ...Array(10).fill(8), ...Array(20).fill(0)];
    expect(new Set(bandSeries(sustained, { window: 1, minRun: 4 })).size).toBe(2);
  });

  it("cuts the number of colour changes on a real-shaped profile", () => {
    // A rolling gradient that crosses thresholds repeatedly.
    const rolling = Array.from({ length: 300 }, (_, i) => 3 + 2.6 * Math.sin(i / 4));
    const runs = (bands: number[]) =>
      bands.reduce((n, b, i) => (i > 0 && b !== bands[i - 1] ? n + 1 : n), 1);
    expect(runs(bandSeries(rolling))).toBeLessThan(runs(rolling.map(gradeBand)));
  });

  it("returns one band per sample, and nothing for nothing", () => {
    expect(bandSeries([1, 2, 3])).toHaveLength(3);
    expect(bandSeries([])).toEqual([]);
  });
});
