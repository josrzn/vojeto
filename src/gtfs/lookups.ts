import type { Pattern, Stop } from "../shared/types.js";

/**
 * The three lookups RAPTOR needs that are pure functions of the stops and
 * patterns: which index a stop id has, which stops make up a station, and which
 * patterns call at a stop.
 *
 * Derived rather than stored, both when the feed is parsed and when a packed
 * index is read back. One implementation on purpose: two would agree until they
 * did not, and the disagreement would surface as a route that exists in the
 * planner and not in the browser, or the other way round.
 */
export interface Lookups {
  stopIndex: Map<string, number>;
  stopsInStation: Map<string, number[]>;
  patternsAtStop: number[][];
}

export function deriveLookups(stops: Stop[], patterns: Pattern[]): Lookups {
  const stopIndex = new Map<string, number>();
  for (let i = 0; i < stops.length; i++) stopIndex.set(stops[i]!.id, i);

  const patternsAtStop: number[][] = Array.from({ length: stops.length }, () => []);
  for (const pattern of patterns) {
    // A pattern that calls at a stop twice — a loop, or a reversal — is still
    // only worth scanning once from that stop.
    const seen = new Set<number>();
    for (const stop of pattern.stops) {
      if (seen.has(stop)) continue;
      seen.add(stop);
      patternsAtStop[stop]!.push(pattern.id);
    }
  }

  const stopsInStation = new Map<string, number[]>();
  for (let i = 0; i < stops.length; i++) {
    const station = stops[i]!.station;
    const group = stopsInStation.get(station);
    if (group) group.push(i);
    else stopsInStation.set(station, [i]);
  }

  return { stopIndex, stopsInStation, patternsAtStop };
}
