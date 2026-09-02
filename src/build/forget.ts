import { normalise } from "./stations.js";
import type { Plan } from "./buildPlan.js";

/**
 * Dropping rides from the plan, so they are asked of BRouter again.
 *
 * The plan is a cache, and every cache needs a way to be told it is wrong. The
 * usual reason is not that a road has changed but that you want to look again:
 * the same station in a different month, or a route you have now ridden and
 * want re-measured against what actually happened.
 *
 * Only `rides` is touched. The ride-time field, the stations with no morning
 * train, the settings the plan was built with — all of that describes the place
 * rather than a particular road home, and throwing it away to re-ask for one
 * route would be a poor trade.
 */
export interface CachedStation {
  stationId: string;
  name: string;
  variants: number;
}

/**
 * Every station the plan holds rides for, named where the plan can name it.
 *
 * `rides` is keyed by station id and carries no names of its own, so they are
 * gathered from the parts of the plan that do. A station the months no longer
 * mention still gets listed, under its id: it is in the cache, so it must be
 * forgettable.
 */
export function cachedStations(plan: Plan): CachedStation[] {
  const names = new Map<string, string>();
  for (const month of plan.months ?? []) {
    for (const destination of month.destinations) names.set(destination.stationId, destination.name);
  }
  for (const rejection of plan.rejected ?? []) names.set(rejection.stationId, rejection.name);

  return Object.entries(plan.rides ?? {})
    .map(([stationId, variants]) => ({
      stationId,
      name: names.get(stationId) ?? stationId,
      variants: variants.length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

export interface Match {
  matched: CachedStation[];
  /** Queries that named nothing in the cache, kept so they can be reported. */
  unmatched: string[];
}

/**
 * The stations named by a list of queries.
 *
 * A query matches a station id exactly, or its name loosely — accents and case
 * ignored, substring allowed — because "villefranche" is what you remember and
 * "StopArea:OCE87721001" is what the plan wrote down. A query that matches
 * several stations forgets all of them: this is reversible by re-running the
 * planner, so being too eager costs a rebuild and being too timid costs a
 * puzzle about why nothing happened.
 */
export function matchStations(stations: CachedStation[], queries: string[]): Match {
  const matched = new Map<string, CachedStation>();
  const unmatched: string[] = [];

  for (const query of queries) {
    const needle = normalise(query);
    if (needle === "") continue;
    const hits = stations.filter(
      (station) => station.stationId === query || normalise(station.name).includes(needle),
    );
    if (hits.length === 0) unmatched.push(query);
    for (const hit of hits) matched.set(hit.stationId, hit);
  }

  return { matched: [...matched.values()], unmatched };
}

/**
 * The .gpx and profile files that only the forgotten rides referred to.
 *
 * Checked against what remains rather than assumed from the names: the files
 * are named after the station and the variant, so a collision should not happen
 * — but deleting a file another ride is still pointing at would show up much
 * later as a chart that will not load, and the check costs nothing.
 */
export function orphanedFiles(
  plan: Plan,
  forgotten: ReadonlySet<string>,
): { gpx: string[]; profiles: string[] } {
  const kept = { gpx: new Set<string>(), profiles: new Set<string>() };
  const going = { gpx: new Set<string>(), profiles: new Set<string>() };

  for (const [stationId, variants] of Object.entries(plan.rides ?? {})) {
    const into = forgotten.has(stationId) ? going : kept;
    for (const variant of variants) {
      if (variant.gpx) into.gpx.add(variant.gpx);
      if (variant.elevationFile) into.profiles.add(variant.elevationFile);
    }
  }

  return {
    gpx: [...going.gpx].filter((file) => !kept.gpx.has(file)),
    profiles: [...going.profiles].filter((file) => !kept.profiles.has(file)),
  };
}

/** The same plan with those stations' rides gone. */
export function forgetRides(plan: Plan, forgotten: ReadonlySet<string>): Plan {
  const rides = Object.fromEntries(
    Object.entries(plan.rides ?? {}).filter(([stationId]) => !forgotten.has(stationId)),
  );
  return { ...plan, rides };
}
