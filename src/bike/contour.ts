/**
 * Contour lines over a regular lat/lon grid, by marching squares.
 *
 * The grid holds ride-time-home in hours. Cells the router could not reach are
 * null and are treated as outside every contour, so unreachable ground leaves a
 * hole rather than inventing a boundary through it.
 */
export interface Grid {
  /** Southern edge, in degrees. */
  south: number;
  /** Western edge, in degrees. */
  west: number;
  /** Spacing between rows, in degrees of latitude. */
  latStep: number;
  /** Spacing between columns, in degrees of longitude. */
  lonStep: number;
  rows: number;
  cols: number;
  /** Row-major, `rows * cols` long. Null where no route was found. */
  values: Array<number | null>;
}

export type Segment = [[number, number], [number, number]];

const at = (grid: Grid, row: number, col: number): number | null =>
  grid.values[row * grid.cols + col] ?? null;

const lonAt = (grid: Grid, col: number): number => grid.west + col * grid.lonStep;
const latAt = (grid: Grid, row: number): number => grid.south + row * grid.latStep;

/**
 * Where along the edge between two samples the contour crosses, linearly
 * interpolated so contours land between grid points rather than on them.
 */
function crossing(a: number, b: number, level: number): number {
  const span = b - a;
  return Math.abs(span) < 1e-12 ? 0.5 : (level - a) / span;
}

/**
 * Line segments where the field equals `level`.
 *
 * Marching squares over each cell of four samples. Corners at exactly the level
 * are nudged so a cell never sits ambiguously on the boundary.
 */
export function contourSegments(grid: Grid, level: number): Segment[] {
  const segments: Segment[] = [];

  for (let row = 0; row < grid.rows - 1; row++) {
    for (let col = 0; col < grid.cols - 1; col++) {
      const bl = at(grid, row, col);
      const br = at(grid, row, col + 1);
      const tl = at(grid, row + 1, col);
      const tr = at(grid, row + 1, col + 1);
      // A cell touching unreachable ground contributes nothing.
      if (bl === null || br === null || tl === null || tr === null) continue;

      // Nudging off the level avoids degenerate zero-length segments.
      const e = 1e-9;
      const v = [bl, br, tr, tl].map((x) => (x === level ? x + e : x)) as [
        number,
        number,
        number,
        number,
      ];

      let code = 0;
      if (v[0] > level) code |= 1;
      if (v[1] > level) code |= 2;
      if (v[2] > level) code |= 4;
      if (v[3] > level) code |= 8;
      if (code === 0 || code === 15) continue;

      const x0 = lonAt(grid, col);
      const x1 = lonAt(grid, col + 1);
      const y0 = latAt(grid, row);
      const y1 = latAt(grid, row + 1);

      // Midpoints of the four edges, where the contour crosses.
      const bottom: [number, number] = [x0 + (x1 - x0) * crossing(v[0], v[1], level), y0];
      const right: [number, number] = [x1, y0 + (y1 - y0) * crossing(v[1], v[2], level)];
      const top: [number, number] = [x0 + (x1 - x0) * crossing(v[3], v[2], level), y1];
      const left: [number, number] = [x0, y0 + (y1 - y0) * crossing(v[0], v[3], level)];

      const push = (a: [number, number], b: [number, number]) => segments.push([a, b]);

      switch (code) {
        case 1: case 14: push(left, bottom); break;
        case 2: case 13: push(bottom, right); break;
        case 3: case 12: push(left, right); break;
        case 4: case 11: push(right, top); break;
        case 6: case 9: push(bottom, top); break;
        case 7: case 8: push(left, top); break;
        // Saddles: the centre decides which way the two lines connect.
        case 5: {
          const centre = (v[0] + v[1] + v[2] + v[3]) / 4;
          if (centre > level) { push(left, top); push(bottom, right); }
          else { push(left, bottom); push(right, top); }
          break;
        }
        case 10: {
          const centre = (v[0] + v[1] + v[2] + v[3]) / 4;
          if (centre > level) { push(left, bottom); push(right, top); }
          else { push(left, top); push(bottom, right); }
          break;
        }
      }
    }
  }

  return segments;
}

/**
 * Joins segments end to end into runs, so the map draws smooth lines.
 *
 * Marching squares emits each segment in whatever order the cell's case
 * produced, with no consistent winding, so joining has to consider both
 * endpoints and flip segments as needed. A closed ring is walked in both
 * directions from the seed and comes back on itself.
 */
export function stitch(segments: Segment[], tolerance = 1e-7): number[][][] {
  const key = (p: readonly [number, number]) =>
    `${Math.round(p[0] / tolerance)},${Math.round(p[1] / tolerance)}`;

  const touching = new Map<string, number[]>();
  segments.forEach((segment, i) => {
    for (const end of segment) {
      const k = key(end);
      const bucket = touching.get(k);
      if (bucket) bucket.push(i);
      else touching.set(k, [i]);
    }
  });

  const used = new Array<boolean>(segments.length).fill(false);

  /** The far end of an unused segment meeting `point`, consuming it. */
  const step = (point: [number, number]): [number, number] | null => {
    for (const i of touching.get(key(point)) ?? []) {
      if (used[i]) continue;
      const segment = segments[i]!;
      const sameStart = key(segment[0]) === key(point);
      // Skip a segment that merely starts and ends at the same place.
      if (!sameStart && key(segment[1]) !== key(point)) continue;
      used[i] = true;
      return sameStart ? segment[1] : segment[0];
    }
    return null;
  };

  const lines: number[][][] = [];
  for (let seed = 0; seed < segments.length; seed++) {
    if (used[seed]) continue;
    used[seed] = true;
    const segment = segments[seed]!;
    const line: Array<[number, number]> = [segment[0], segment[1]];

    for (let next = step(line[line.length - 1]!); next; next = step(line[line.length - 1]!)) {
      line.push(next);
    }
    for (let previous = step(line[0]!); previous; previous = step(line[0]!)) {
      line.unshift(previous);
    }

    if (line.length > 1) lines.push(line.map((p) => [p[0], p[1]]));
  }

  return lines;
}

/** GeoJSON MultiLineString features, one per level. */
export function contourFeatures(
  grid: Grid,
  levels: number[],
): Array<{ level: number; coordinates: number[][][] }> {
  return levels.map((level) => ({
    level,
    coordinates: stitch(contourSegments(grid, level)),
  }));
}
