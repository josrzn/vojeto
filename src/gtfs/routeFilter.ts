/** The fields of one routes.txt row that decide whether we keep it. */
export interface RouteInfo {
  routeId: string;
  agencyName: string;
  shortName: string;
  longName: string;
  description: string;
  routeType: string;
}

export interface RouteFilter {
  /** Keep a route when any of these matches its label. Empty means "any label". */
  keepPatterns: RegExp[];
  /** ...unless one of these matches, which wins. */
  dropPatterns: RegExp[];
  /** When set, only these route_type values are considered, instead of "any rail". */
  keepTypes?: number[];
}

/**
 * GTFS route_type 2 is rail. The extended set adds 100-117 for rail services
 * (102 long distance, 106 regional, and so on), which real feeds do use, so
 * both spellings have to be accepted.
 */
export function isRailType(routeType: string): boolean {
  const trimmed = routeType.trim();
  if (trimmed === "") return true;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return false;
  return value === 2 || (value >= 100 && value <= 117);
}

/** The human-readable text the keep/drop patterns are matched against. */
export function routeLabel(info: RouteInfo): string {
  return [info.agencyName, info.shortName, info.longName, info.description]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" | ");
}

export function keepRoute(info: RouteInfo, filter: RouteFilter): boolean {
  const typeAllowed = filter.keepTypes
    ? filter.keepTypes.includes(Number(info.routeType))
    : isRailType(info.routeType);
  if (!typeAllowed) return false;

  const label = routeLabel(info);
  if (filter.dropPatterns.some((re) => re.test(label))) return false;
  // No keep patterns configured means "keep every rail route".
  if (filter.keepPatterns.length === 0) return true;
  return filter.keepPatterns.some((re) => re.test(label));
}

/**
 * Explains what the filter did to a whole routes.txt.
 *
 * This is what gets printed when nothing matched, so it has to be enough on its
 * own to work out why: whether routes were read at all, which route_type values
 * exist and how each fared, and a sample of the actual labels.
 */
export function diagnose(routes: RouteInfo[], filter: RouteFilter, sampleSize = 40): string {
  const lines: string[] = [];

  if (routes.length === 0) {
    return [
      "routes.txt produced no rows at all.",
      "That is a parsing or archive problem rather than a filter problem:",
      "check that the feed really is the SNCF GTFS zip and not an error page.",
    ].join("\n");
  }

  const byType = new Map<string, { total: number; kept: number }>();
  const labels = new Map<string, boolean>();
  for (const route of routes) {
    const type = route.routeType.trim() || "(empty)";
    const kept = keepRoute(route, filter);
    const bucket = byType.get(type) ?? { total: 0, kept: 0 };
    bucket.total++;
    if (kept) bucket.kept++;
    byType.set(type, bucket);
    labels.set(routeLabel(route), kept);
  }

  lines.push(`${routes.length} routes read, ${labels.size} distinct labels.`);
  lines.push("");
  lines.push("By route_type:");
  for (const [type, counts] of [...byType].sort()) {
    const rail = isRailType(type === "(empty)" ? "" : type) ? "rail" : "not rail";
    lines.push(`  route_type ${type.padEnd(8)} ${String(counts.total).padStart(5)} routes` +
      `, ${counts.kept} kept  (${rail})`);
  }

  const kept = [...labels].filter(([, k]) => k).map(([l]) => l);
  const dropped = [...labels].filter(([, k]) => !k).map(([l]) => l);

  lines.push("");
  lines.push(`Kept labels (${kept.length}):`);
  for (const label of kept.slice(0, sampleSize)) lines.push(`  KEEP  ${label}`);
  if (kept.length > sampleSize) lines.push(`  ... and ${kept.length - sampleSize} more`);

  lines.push("");
  lines.push(`Dropped labels (${dropped.length}):`);
  for (const label of dropped.slice(0, sampleSize)) lines.push(`  drop  ${label}`);
  if (dropped.length > sampleSize) lines.push(`  ... and ${dropped.length - sampleSize} more`);

  return lines.join("\n");
}
