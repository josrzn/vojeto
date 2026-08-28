/**
 * The SNCF feed encodes the service type in the stop point id rather than in
 * routes.txt, which carries no usable TER/TGV distinction at all:
 *
 *   StopPoint:OCETrain TER-87726802     a regional train
 *   StopPoint:OCECar TER-87726802       a replacement coach
 *   StopPoint:OCEINTERCITES-87726802    an Intercités
 *   StopArea:OCE87726802                the station the three of them share
 *
 * Every trip in the feed calls exclusively at stop points of one kind, so this
 * classifies trips as well as stops.
 */

/** "StopPoint:OCETrain TER-87726802" -> "OCETrain TER". Null for anything else. */
export function stopKind(stopId: string): string | null {
  if (!stopId.startsWith("StopPoint:")) return null;
  const body = stopId.slice("StopPoint:".length);
  const split = body.lastIndexOf("-");
  if (split <= 0) return null;
  return body.slice(0, split);
}

/**
 * Which services to keep, said as what to leave out.
 *
 * A deny list rather than an allow list, and the difference matters. Regional
 * trains are branded by region — TER in most of France, but BreizhGo in
 * Brittany, Nomad in Normandy, liO, Rémi, ZOU!, Mobigo, Aléop elsewhere — and
 * naming the ones you want means silently losing every region you did not think
 * of. Naming what you are avoiding fails the other way: an unfamiliar brand is
 * kept, and shows up as trains you can look at rather than as an absence you
 * cannot see.
 *
 * `keep`, when non-empty, is an exact allow list and overrides `drop` entirely,
 * for someone who knows precisely what their feed contains.
 */
export interface KindFilter {
  keep: ReadonlySet<string>;
  drop: readonly RegExp[];
}

export const NO_KIND_FILTER: KindFilter = { keep: new Set(), drop: [] };

/** Whether a kind survives the filter. A null kind cannot be judged, so it stays. */
export function keepKind(kind: string | null, filter: KindFilter): boolean {
  if (kind === null) return true;
  if (filter.keep.size > 0) return filter.keep.has(kind);
  return !filter.drop.some((pattern) => pattern.test(kind));
}

/** Whether a stop belongs to a kept service. */
export function keepStop(stopId: string, filter: KindFilter): boolean {
  return keepKind(stopKind(stopId), filter);
}

/** Counts stop kinds, for the ingest diagnostic. */
export function summariseKinds(stopIds: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of stopIds) {
    const kind = stopKind(id) ?? (id.startsWith("StopArea:") ? "(station)" : "(no kind)");
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return counts;
}

/**
 * Drop patterns that matched nothing in this feed.
 *
 * Worth saying out loud: a pattern that matches nothing is either a service
 * this feed does not carry, or a name that has changed under you. Both are
 * silent otherwise, and the second one quietly widens what you are planning
 * with.
 */
export function unusedDropPatterns(
  kinds: Iterable<string>,
  filter: KindFilter,
): RegExp[] {
  const present = [...kinds];
  return filter.drop.filter((pattern) => !present.some((kind) => pattern.test(kind)));
}
