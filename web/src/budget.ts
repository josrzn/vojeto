import { fitsBudget, type Budget } from "../../src/bike/effort.js";
import type { PlanDestination, PlanRideVariant } from "../../src/build/buildPlan.js";

/**
 * Re-deciding what fits, in the browser, without routing anything.
 *
 * How long a ride takes does not depend on how much time you have — only on the
 * road and your legs. So every verdict in the plan is a pure function of the
 * ride durations, the train time and the budget, and the budget is the only one
 * of those a slider touches. Nothing here talks to BRouter or to the timetable.
 *
 * The invariant that makes this trustworthy: re-deciding with the budget the
 * plan was *built* with must reproduce the plan exactly. If it does not, the
 * panel is quietly showing you a different app than the one that made the file.
 */
export interface Reckoned {
  /** Destinations still worth going to, in the order they were given. */
  destinations: PlanDestination[];
  /** Every routed variant for a kept station, verdicts recomputed. */
  rides: Record<string, PlanRideVariant[]>;
  /** Stations the train reaches but that no longer work, and why. */
  rejected: Rejection[];
}

export interface Rejection {
  stationId: string;
  name: string;
  km: number;
  hours: number;
  trainHours: number;
  verdict: "tooShort" | "overruns";
  /** For "overruns": the budget that would let this ride in. */
  neededBudgetHours: number | null;
}

/**
 * How long the train took to the station the plan was built against.
 *
 * Shipped rather than derived from the month on screen: the plan judged each
 * station by its *quickest* train across every month, since that is the one
 * leaving the most time to ride. Recomputing from whichever month you happen to
 * be looking at would make stations flicker in and out as you change month,
 * which is not something a budget slider should do.
 */
export type TrainHours = Record<string, number>;

export function reckon(
  destinations: PlanDestination[],
  rides: Record<string, PlanRideVariant[]>,
  trainHours: TrainHours,
  budget: Budget,
): Reckoned {
  const kept: PlanDestination[] = [];
  const out: Record<string, PlanRideVariant[]> = {};
  const rejected: Rejection[] = [];

  for (const destination of destinations) {
    const variants = rides[destination.stationId];
    if (!variants?.length) continue;

    const hours = trainHours[destination.stationId] ?? destination.travelMinutes / 60;
    const judged = variants.map((variant) => ({
      ...variant,
      ...fitsBudget(hours, variant.hours, budget),
    }));

    // "Worth the fare" is a property of the place, not of the route you choose:
    // if the most direct way home is short, dawdling back by a longer one does
    // not make it a trip you needed a train for.
    const shortest = judged.reduce((least, v) => Math.min(least, v.hours), Infinity);
    const usable = shortest < budget.minHours ? [] : judged.filter((v) => v.feasible);

    if (usable.length === 0) {
      rejected.push(explain(destination, judged, hours, budget));
      continue;
    }

    kept.push(destination);
    // Unusable variants are kept alongside: seeing why one way home missed out
    // is more useful than it silently vanishing from the list.
    out[destination.stationId] = judged;
  }

  return { destinations: kept, rides: out, rejected };
}

/**
 * Why a station did not make it, described by its most direct way home.
 *
 * The shortest ride is what decides both verdicts — it is the one that has to
 * clear `minHours`, and the one whose overrun is smallest — so it is the one
 * worth reporting.
 */
function explain(
  destination: PlanDestination,
  variants: PlanRideVariant[],
  trainHours: number,
  budget: Budget,
): Rejection {
  const best = variants.reduce((least, v) => (v.hours < least.hours ? v : least), variants[0]!);
  const verdict = fitsBudget(trainHours, best.hours, budget);
  return {
    stationId: destination.stationId,
    name: destination.name,
    km: best.km,
    hours: best.hours,
    trainHours,
    verdict: verdict.verdict === "tooShort" ? "tooShort" : "overruns",
    neededBudgetHours: verdict.neededBudgetHours,
  };
}
