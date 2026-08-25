/**
 * The SNCF feed encodes the service type in the stop point id rather than in
 * routes.txt, which carries no usable TER/TGV distinction at all:
 *
 *   StopPoint:OCETrain TER-87726802     a TER train
 *   StopPoint:OCECar TER-87726802       a TER replacement coach
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
 * Whether a stop belongs to a kept service.
 *
 * An empty `keep` set means the feed does not use this convention, so no stop
 * is filtered out on these grounds.
 */
export function keepStop(stopId: string, keep: ReadonlySet<string>): boolean {
  if (keep.size === 0) return true;
  const kind = stopKind(stopId);
  // Stops that carry no kind cannot be judged, so they are left in.
  return kind === null ? true : keep.has(kind);
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
