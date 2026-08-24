export interface Point {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_371_000;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: Point, b: Point): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Running distance in metres at each vertex of a [lon, lat, ...] polyline. */
export function cumulativeDistances(coordinates: number[][]): number[] {
  const totals = new Array<number>(coordinates.length).fill(0);
  for (let i = 1; i < coordinates.length; i++) {
    const previous = coordinates[i - 1]!;
    const current = coordinates[i]!;
    totals[i] =
      totals[i - 1]! +
      haversine(
        { lon: previous[0]!, lat: previous[1]! },
        { lon: current[0]!, lat: current[1]! },
      );
  }
  return totals;
}

export function nearest<T extends Point>(target: Point, candidates: T[]): { item: T; metres: number } | null {
  let best: { item: T; metres: number } | null = null;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lon)) continue;
    const metres = haversine(target, candidate);
    if (!best || metres < best.metres) best = { item: candidate, metres };
  }
  return best;
}
