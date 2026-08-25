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

/**
 * Parses a coordinate written either as decimal degrees or as degrees,
 * minutes and seconds:
 *
 *   46.034389, 4.079342
 *   46°02'03.80"N 4°04'45.63"E
 *
 * Accepts the usual substitutes for the degree, minute and second marks, since
 * these get copied out of mapping apps in whatever form they happen to use.
 */
export function parsePoint(value: string): Point {
  const text = value.trim();

  const dms = [...text.matchAll(DMS)];
  if (dms.length >= 2) {
    const parsed = dms.slice(0, 2).map(toDegrees);
    // Trust the hemisphere letters over the order when they are present.
    const latFirst = !/^[EW]$/i.test(dms[0]![4] ?? "");
    const [lat, lon] = latFirst ? parsed : [parsed[1]!, parsed[0]!];
    return check(lat!, lon!, value);
  }

  const decimal = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (decimal) return check(Number(decimal[1]), Number(decimal[2]), value);

  throw new Error(
    `Cannot read ${JSON.stringify(value)} as a coordinate. ` +
      `Use "46.034389, 4.079342" or "46°02'03.80\\"N 4°04'45.63\\"E".`,
  );
}

// degrees, then optional minutes, seconds and hemisphere letter.
const DMS =
  /(-?\d+(?:\.\d+)?)\s*[°d:]\s*(?:(\d+(?:\.\d+)?)\s*['′m:]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:["″s]|'')\s*)?([NSEW])?/gi;

function toDegrees(match: RegExpMatchArray): number {
  const degrees = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const hemisphere = (match[4] ?? "").toUpperCase();
  const magnitude = Math.abs(degrees) + minutes / 60 + seconds / 3600;
  const negative = degrees < 0 || hemisphere === "S" || hemisphere === "W";
  return negative ? -magnitude : magnitude;
}

function check(lat: number, lon: number, original: string): Point {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new Error(`Latitude out of range in ${JSON.stringify(original)}`);
  }
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new Error(`Longitude out of range in ${JSON.stringify(original)}`);
  }
  return { lat, lon };
}
