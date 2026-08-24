import type { TimetableIndex } from "../shared/types.js";

/** Lowercases and strips accents, so "Saint-Étienne" matches "saint-etienne". */
export function normalise(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export interface StationMatch {
  stationId: string;
  name: string;
  lat: number;
  lon: number;
}

export function searchStations(index: TimetableIndex, query: string): StationMatch[] {
  const needle = normalise(query);
  const seen = new Map<string, StationMatch>();
  for (const stop of index.stops) {
    if (seen.has(stop.station)) continue;
    if (!normalise(stop.name).includes(needle)) continue;
    seen.set(stop.station, {
      stationId: stop.station,
      name: stop.name,
      lat: stop.lat,
      lon: stop.lon,
    });
  }
  // Exact names first, then shortest, so "Roanne" beats "Roanne-Le Coteau".
  return [...seen.values()].sort((a, b) => {
    const exact = Number(normalise(b.name) === needle) - Number(normalise(a.name) === needle);
    return exact !== 0 ? exact : a.name.length - b.name.length;
  });
}

/**
 * Resolves the configured home to exactly one station, failing loudly rather
 * than silently guessing when the name is ambiguous.
 */
export function resolveHome(
  index: TimetableIndex,
  home: { query: string; stopId: string | null },
): StationMatch {
  if (home.stopId) {
    const stopIndex = index.stopIndex.get(home.stopId);
    const station = stopIndex !== undefined ? index.stops[stopIndex]!.station : home.stopId;
    const stops = index.stopsInStation.get(station);
    if (!stops?.length) {
      throw new Error(`home.stopId ${home.stopId} is not served by any kept route`);
    }
    const stop = index.stops[stops[0]!]!;
    return { stationId: station, name: stop.name, lat: stop.lat, lon: stop.lon };
  }

  const matches = searchStations(index, home.query);
  if (matches.length === 0) {
    throw new Error(
      `No station matches home.query ${JSON.stringify(home.query)}. Try: npm run stations -- <name>`,
    );
  }
  if (matches.length > 1 && normalise(matches[0]!.name) !== normalise(home.query)) {
    const options = matches.slice(0, 8).map((m) => `  ${m.stationId}  ${m.name}`).join("\n");
    throw new Error(
      `home.query ${JSON.stringify(home.query)} is ambiguous. Set home.stopId to one of:\n${options}`,
    );
  }
  return matches[0]!;
}
