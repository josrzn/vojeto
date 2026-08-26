import { describe, expect, it } from "vitest";
import { contourFeatures, contourSegments, stitch, type Grid } from "../src/bike/contour.js";

/** A grid whose value is a function of position, for predictable geometry. */
function build(
  rows: number,
  cols: number,
  f: (row: number, col: number) => number | null,
): Grid {
  const values: Array<number | null> = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) values.push(f(row, col));
  }
  return { south: 45, west: 4, latStep: 0.1, lonStep: 0.1, rows, cols, values };
}

describe("contourSegments", () => {
  it("finds nothing when the whole field is below the level", () => {
    expect(contourSegments(build(4, 4, () => 1), 5)).toEqual([]);
  });

  it("finds nothing when the whole field is above the level", () => {
    expect(contourSegments(build(4, 4, () => 9), 5)).toEqual([]);
  });

  it("draws a straight line across a linear ramp", () => {
    // Value rises with the column only, so the level-2.5 contour is vertical.
    const segments = contourSegments(build(4, 6, (_row, col) => col), 2.5);
    expect(segments.length).toBeGreaterThan(0);
    for (const [a, b] of segments) {
      // Every crossing sits between columns 2 and 3, i.e. lon 4.25.
      expect(a[0]).toBeCloseTo(4.25, 6);
      expect(b[0]).toBeCloseTo(4.25, 6);
    }
  });

  it("places the crossing by interpolation, not on the nearest grid point", () => {
    // 0 and 10 either side: the level-2 contour sits a fifth of the way across.
    const segments = contourSegments(build(2, 2, (_row, col) => col * 10), 2);
    expect(segments[0]![0][0]).toBeCloseTo(4 + 0.1 * 0.2, 6);
  });

  it("closes a ring around a peak", () => {
    // A single high cell in the middle should give a closed loop around it.
    const grid = build(5, 5, (row, col) => (row === 2 && col === 2 ? 10 : 0));
    const lines = stitch(contourSegments(grid, 5));
    expect(lines).toHaveLength(1);
    const [first] = lines;
    expect(first![0]).toEqual(first!.at(-1));
  });

  it("leaves a hole rather than guessing across unreachable ground", () => {
    // Null in the middle: no cell touching it may contribute a segment.
    const grid = build(5, 5, (row, col) => (row === 2 && col === 2 ? null : col));
    const segments = contourSegments(grid, 1.5);
    for (const [a, b] of segments) {
      for (const point of [a, b]) {
        // Nothing may be drawn inside the four cells around the missing sample.
        const nearHole = Math.abs(point[0] - 4.2) < 0.05 && Math.abs(point[1] - 45.2) < 0.05;
        expect(nearHole).toBe(false);
      }
    }
  });

  it("resolves a saddle without leaving a dangling end", () => {
    // Diagonally opposed highs and lows, the classic ambiguous case.
    const grid = build(2, 2, (row, col) => (row === col ? 10 : 0));
    const segments = contourSegments(grid, 5);
    expect(segments).toHaveLength(2);
  });
});

describe("stitch", () => {
  it("joins segments sharing an endpoint into one run", () => {
    const lines = stitch([
      [[0, 0], [1, 0]],
      [[1, 0], [2, 0]],
      [[2, 0], [3, 0]],
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(4);
  });

  it("keeps unrelated runs apart", () => {
    const lines = stitch([
      [[0, 0], [1, 0]],
      [[5, 5], [6, 5]],
    ]);
    expect(lines).toHaveLength(2);
  });

  it("uses every segment exactly once", () => {
    const segments = contourSegments(build(6, 6, (row, col) => row + col), 4);
    const total = stitch(segments).reduce((n, line) => n + line.length - 1, 0);
    expect(total).toBe(segments.length);
  });
});

describe("contourFeatures", () => {
  it("returns one entry per level, ordered as asked", () => {
    const grid = build(6, 6, (row, col) => row + col);
    const features = contourFeatures(grid, [2, 4, 6]);
    expect(features.map((f) => f.level)).toEqual([2, 4, 6]);
    for (const feature of features) expect(feature.coordinates.length).toBeGreaterThan(0);
  });

  it("gives an empty geometry for a level the field never reaches", () => {
    const features = contourFeatures(build(4, 4, () => 1), [99]);
    expect(features[0]!.coordinates).toEqual([]);
  });

  it("nests contours: a higher level sits inside a lower one", () => {
    // Value grows with distance from the centre, so 2 encloses 4.
    const grid = build(9, 9, (row, col) => Math.hypot(row - 4, col - 4));
    const [inner, outer] = contourFeatures(grid, [1, 3]);
    const spread = (lines: number[][][]) => {
      const xs = lines.flat().map((p) => p[0]!);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(spread(inner!.coordinates)).toBeLessThan(spread(outer!.coordinates));
  });
});
