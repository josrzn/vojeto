import { fitsBudget, type Budget } from "../../src/bike/effort.js";
import type { PlanRideVariant } from "../../src/build/buildPlan.js";

/**
 * Re-deciding what fits, in the browser, without routing anything.
 *
 * How long a ride takes does not depend on how much time you have — only on the
 * road and your legs. So every verdict is a pure function of the ride duration,
 * the train time and the budget, and the budget is the only one of those a
 * slider touches. Nothing here talks to BRouter or to the timetable.
 *
 * The invariant that makes this trustworthy: judging a ride at the budget its
 * plan was *built* with must reproduce that plan's own verdict. If it does not,
 * the panel is quietly showing you a different app than the one that made the
 * file.
 */
export interface Judged {
  /** Every way home known for this station, quickest first, verdicts recomputed. */
  variants: PlanRideVariant[];
  /** Whether any of them fits the day. */
  feasible: boolean;
  /**
   * True when even the most direct way home is too short to be worth the fare.
   *
   * A property of the place, not of the route you choose: if the shortest way
   * back is an hour, dawdling home by a longer one does not make it a trip you
   * needed a train for.
   */
  tooShort: boolean;
  /** The budget that would let the best of them in, when none fits on time. */
  neededBudgetHours: number | null;
}

export function judge(
  variants: PlanRideVariant[],
  trainHours: number,
  budget: Budget,
): Judged {
  const judged = variants
    .map((variant) => ({ ...variant, ...fitsBudget(trainHours, variant.hours, budget) }))
    // Quickest first: the shortest way home for a given day is the one you are
    // most likely to be looking for, whatever order they were fetched in.
    .sort((a, b) => a.hours - b.hours);

  const shortest = judged.reduce((least, v) => Math.min(least, v.hours), Infinity);
  const best = judged[0] ?? null;
  return {
    variants: judged,
    feasible: judged.some((v) => v.feasible),
    tooShort: judged.length > 0 && shortest < budget.minHours,
    neededBudgetHours: best ? fitsBudget(trainHours, best.hours, budget).neededBudgetHours : null,
  };
}
