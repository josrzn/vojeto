import type { Grid } from "./contour.js";
import { haversine, type Point } from "../shared/geo.js";
import { routeBike, type BRouterOptions } from "./brouter.js";
import { rideHours, type EffortModel } from "./effort.js";

export interface FieldOptions extends Omit<BRouterOptions, "alternative"> {
  effort: EffortModel;
  /** Half-width of the sampled square, in km. */
  radiusKm: number;
  /** Distance between samples, in km. Cost grows with the square of this. */
  spacingKm: number;
  onProgress?: (done: number, total: number) => void;
}

const KM_PER_DEGREE_LAT = 110.574;

/**
 * How long it takes to ride home from anywhere, sampled on a grid.
 *
 * The station-by-station routes are the authoritative numbers; this exists to
 * give the map a continuous backdrop, which is the honest way to draw the
 * asymmetry: riding home is possible from any point, catching a train is not.
 *
 * Points BRouter cannot route (mid-lake, across a border with no roads) stay
 * null so the contours leave a hole instead of inventing ground.
 */
export async function sampleRideField(home: Point, options: FieldOptions): Promise<Grid> {
  const latStep = options.spacingKm / KM_PER_DEGREE_LAT;
  const lonStep =
    options.spacingKm / (KM_PER_DEGREE_LAT * Math.cos((home.lat * Math.PI) / 180));

  const half = Math.ceil(options.radiusKm / options.spacingKm);
  const rows = half * 2 + 1;
  const cols = half * 2 + 1;
  const south = home.lat - half * latStep;
  const west = home.lon - half * lonStep;

  const values: Array<number | null> = new Array(rows * cols).fill(null);
  const total = rows * cols;
  let done = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const point = { lat: south + row * latStep, lon: west + col * lonStep };
      done++;
      options.onProgress?.(done, total);

      // Skip the corners of the square: they are outside the radius we care
      // about and each one costs a request.
      if (haversine(home, point) > options.radiusKm * 1000) continue;

      try {
        const track = await routeBike([point, home], {
          baseUrl: options.baseUrl,
          cacheDir: options.cacheDir,
          profile: options.profile,
          alternative: 0,
          ...(options.throttleMs !== undefined ? { throttleMs: options.throttleMs } : {}),
        });
        values[row * cols + col] = rideHours(
          track.metres / 1000,
          track.ascentMetres,
          options.effort,
        );
      } catch {
        // Leave it null: no road home from here that BRouter knows about.
      }
    }
  }

  return { south, west, latStep, lonStep, rows, cols, values };
}

/** How many routing requests a given grid will cost, for warning before it runs. */
export function sampleCount(radiusKm: number, spacingKm: number): number {
  const half = Math.ceil(radiusKm / spacingKm);
  let count = 0;
  for (let row = -half; row <= half; row++) {
    for (let col = -half; col <= half; col++) {
      if (Math.hypot(row, col) * spacingKm <= radiusKm) count++;
    }
  }
  return count;
}
