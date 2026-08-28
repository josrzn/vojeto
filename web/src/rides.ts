import { sameHome, type Home } from "./explore.js";
import { homeFromPlan } from "./settings.js";
import type { Plan, PlanRideVariant } from "../../src/build/buildPlan.js";

/** Ways home already known, by station. */
export type Rides = Record<string, PlanRideVariant[]>;

/**
 * The plan as a warm cache.
 *
 * `npm run plan` routes every station overnight; this app routes one when you
 * click it. Those are the same rides, so a plan built for the pair you are
 * currently looking at is simply a page that starts with its answers already
 * filled in — nothing more, and nothing you have to have. Built for a different
 * station or a different door, it is about a different set of roads and is
 * ignored rather than shown as if it were about yours.
 */
export function warmCache(plan: Plan | null, home: Home | null): Rides {
  if (!plan || !home || !sameHome(homeFromPlan(plan), home)) return {};
  return plan.rides ?? {};
}

/** The same rides with one more way home added, replacing any of the same id. */
export function withVariant(
  rides: Rides,
  stationId: string,
  variant: PlanRideVariant,
): Rides {
  const existing = rides[stationId] ?? [];
  return {
    ...rides,
    [stationId]: [...existing.filter((v) => v.id !== variant.id), variant],
  };
}
