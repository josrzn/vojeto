import type { TimetableIndex } from "../shared/types.js";
import { cumulativeDistances, haversine, nearest, type Point } from "../shared/geo.js";
import { routeBike, type BRouterOptions } from "./brouter.js";

export interface BailoutStation {
  stationId: string;
  name: string;
  /** How far off the route the station is, in km. */
  detourKm: number;
}

export interface RideStage {
  day: number;
  km: number;
  ascentMetres: number;
  end: Point;
  /** Nearest station to the overnight stop, if you want to cut the ride short. */
  bailout: BailoutStation | null;
}

export interface RideHome {
  km: number;
  ascentMetres: number;
  /** BRouter's time estimate for the profile, in hours, excluding stops. */
  ridingHours: number;
  days: number;
  stages: RideStage[];
  /** Simplified [lon, lat] polyline, small enough to ship to the browser. */
  geometry: number[][];
}

export interface RideOptions extends BRouterOptions {
  /** How far you actually want to ride in a day. */
  kmPerDay: number;
  /** Routes longer than this are reported but flagged as unrealistic. */
  maxTotalKm: number;
  /** A station further than this from an overnight stop is not a useful escape. */
  maxBailoutKm?: number;
}

/** Every distinct station in the feed that has usable coordinates. */
export function stationPoints(
  index: TimetableIndex,
): Array<Point & { stationId: string; name: string }> {
  const seen = new Map<string, Point & { stationId: string; name: string }>();
  for (const stop of index.stops) {
    if (seen.has(stop.station)) continue;
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
    seen.set(stop.station, {
      stationId: stop.station,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
    });
  }
  return [...seen.values()];
}

/**
 * Plans the ride from a destination station back to home, split into days.
 *
 * Splits fall wherever the running distance crosses a multiple of `kmPerDay`,
 * and each one is tagged with the nearest station so an overnight stop doubles
 * as a place to give up and take the train.
 */
export async function planRideHome(
  from: Point,
  home: Point,
  stations: Array<Point & { stationId: string; name: string }>,
  options: RideOptions,
): Promise<RideHome> {
  const track = await routeBike([from, home], options);
  // Distances are measured off the returned polyline rather than taken from
  // BRouter's own track-length, so the stage lengths always add up to the total.
  const totals = cumulativeDistances(track.coordinates);
  const totalMetres = totals.at(-1) ?? 0;
  const km = totalMetres / 1000;
  const days = Math.max(1, Math.ceil(km / options.kmPerDay));

  // BRouter's filtered ascent is the trustworthy total; raw per-vertex deltas
  // are only used to share it out between stages in the right proportion.
  const rawAscents = stageRawAscents(track.coordinates, totals, days, totalMetres);
  const rawTotal = rawAscents.reduce((sum, value) => sum + value, 0);

  const stages: RideStage[] = [];
  for (let day = 1; day <= days; day++) {
    const endMetres = day === days ? totalMetres : (totalMetres / days) * day;
    const vertex = vertexAt(totals, endMetres);
    const end: Point = { lon: track.coordinates[vertex]![0]!, lat: track.coordinates[vertex]![1]! };
    const startMetres = day === 1 ? 0 : (totalMetres / days) * (day - 1);

    stages.push({
      day,
      km: (endMetres - startMetres) / 1000,
      ascentMetres:
        rawTotal > 0 ? Math.round((track.ascentMetres * rawAscents[day - 1]!) / rawTotal) : 0,
      end,
      bailout: day === days ? null : findBailout(end, stations, options.maxBailoutKm ?? 15),
    });
  }

  return {
    km,
    ascentMetres: track.ascentMetres,
    ridingHours: track.estimatedSeconds / 3600,
    days,
    stages,
    geometry: simplify(track.coordinates, 150),
  };
}

function findBailout(
  point: Point,
  stations: Array<Point & { stationId: string; name: string }>,
  maxKm: number,
): BailoutStation | null {
  const closest = nearest(point, stations);
  if (!closest || closest.metres > maxKm * 1000) return null;
  return {
    stationId: closest.item.stationId,
    name: closest.item.name,
    detourKm: closest.metres / 1000,
  };
}

/** First vertex at or past `metres` along the track. */
function vertexAt(totals: number[], metres: number): number {
  let low = 0;
  let high = totals.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (totals[mid]! < metres) low = mid + 1;
    else high = mid;
  }
  return low;
}

function stageRawAscents(
  coordinates: number[][],
  totals: number[],
  days: number,
  totalMetres: number,
): number[] {
  const ascents = new Array<number>(days).fill(0);
  for (let i = 1; i < coordinates.length; i++) {
    const climb = (coordinates[i]![2] ?? 0) - (coordinates[i - 1]![2] ?? 0);
    if (climb <= 0) continue;
    const day = Math.min(days - 1, Math.floor((totals[i]! / totalMetres) * days));
    ascents[day] = ascents[day]! + climb;
  }
  return ascents;
}

/**
 * Ramer-Douglas-Peucker, dropping altitude. A cross-France route is thousands
 * of vertices; at a ~150 m tolerance it stays visually identical on a map but
 * ships a fraction of the JSON.
 */
export function simplify(coordinates: number[][], toleranceMetres: number): number[][] {
  if (coordinates.length <= 2) return coordinates.map((c) => [c[0]!, c[1]!]);

  const keep = new Uint8Array(coordinates.length);
  keep[0] = 1;
  keep[coordinates.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, coordinates.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let furthest = -1;
    let maxDistance = toleranceMetres;
    for (let i = start + 1; i < end; i++) {
      const distance = perpendicularDistance(coordinates[i]!, coordinates[start]!, coordinates[end]!);
      if (distance > maxDistance) {
        maxDistance = distance;
        furthest = i;
      }
    }
    if (furthest < 0) continue;
    keep[furthest] = 1;
    stack.push([start, furthest], [furthest, end]);
  }

  const result: number[][] = [];
  for (let i = 0; i < coordinates.length; i++) {
    if (keep[i]) result.push([coordinates[i]![0]!, coordinates[i]![1]!]);
  }
  return result;
}

function perpendicularDistance(point: number[], start: number[], end: number[]): number {
  const p = { lon: point[0]!, lat: point[1]! };
  const a = { lon: start[0]!, lat: start[1]! };
  const b = { lon: end[0]!, lat: end[1]! };

  const segment = haversine(a, b);
  if (segment === 0) return haversine(p, a);

  // Project in a locally flat frame; over a segment this short the error is
  // far below the tolerance we are comparing against.
  const scale = Math.cos((a.lat * Math.PI) / 180);
  const ax = a.lon * scale;
  const bx = b.lon * scale;
  const px = p.lon * scale;
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * (bx - ax) + (p.lat - a.lat) * (b.lat - a.lat)) /
      ((bx - ax) ** 2 + (b.lat - a.lat) ** 2)),
  );
  return haversine(p, { lon: (ax + t * (bx - ax)) / scale, lat: a.lat + t * (b.lat - a.lat) });
}
