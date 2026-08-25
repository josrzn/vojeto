import type { PlanDestination } from "../../src/build/buildPlan.js";
import type { RideVariant } from "../../src/bike/returnRoute.js";

export interface Corridor {
  name: string;
  /** Stations along this line, ordered by how far the ride home is. */
  destinations: PlanDestination[];
  shortestRideKm: number;
  longestRideKm: number;
  quickestTrainMinutes: number;
  slowestTrainMinutes: number;
}

/** The variant a station is best represented by: the quickest one that fits. */
export function bestVariant(variants: RideVariant[] | undefined): RideVariant | null {
  if (!variants?.length) return null;
  return variants.find((v) => v.feasible) ?? variants[0]!;
}

/**
 * Groups stations by the line of their final leg.
 *
 * Stations along one line produce near-identical trips at different lengths, so
 * showing them as a corridor with a range turns 110 near-duplicates into a
 * handful of real choices, each with a difficulty ladder inside it.
 */
export function groupIntoCorridors(
  destinations: PlanDestination[],
  rides: Record<string, RideVariant[]>,
): Corridor[] {
  const groups = new Map<string, PlanDestination[]>();
  for (const destination of destinations) {
    const key = destination.corridor || destination.name;
    const group = groups.get(key);
    if (group) group.push(destination);
    else groups.set(key, [destination]);
  }

  const corridors: Corridor[] = [];
  for (const [name, group] of groups) {
    const withRide = group.map((d) => ({ d, km: bestVariant(rides[d.stationId])?.km ?? NaN }));
    withRide.sort((a, b) => (a.km || 0) - (b.km || 0));

    const kms = withRide.map((x) => x.km).filter(Number.isFinite);
    const minutes = group.map((d) => d.travelMinutes);
    corridors.push({
      name,
      destinations: withRide.map((x) => x.d),
      shortestRideKm: kms.length ? Math.min(...kms) : NaN,
      longestRideKm: kms.length ? Math.max(...kms) : NaN,
      quickestTrainMinutes: Math.min(...minutes),
      slowestTrainMinutes: Math.max(...minutes),
    });
  }

  // Shortest ride first, so the easiest outings are at the top.
  corridors.sort((a, b) => (a.shortestRideKm || 0) - (b.shortestRideKm || 0));
  return corridors;
}

export function formatHours(hours: number): string {
  const whole = Math.floor(hours);
  const minutes = Math.round((hours - whole) * 60);
  if (minutes === 60) return `${whole + 1}h00`;
  return `${whole}h${String(minutes).padStart(2, "0")}`;
}

export function formatMinutes(minutes: number): string {
  return minutes < 60
    ? `${minutes}min`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}
