import { describe, expect, it } from "vitest";
import { judge } from "../web/src/budget.js";
import type { Budget } from "../src/bike/effort.js";
import type { PlanRideVariant } from "../src/build/buildPlan.js";

const budget: Budget = { budgetHours: 10, maxDays: 1, hoursPerDay: 6, minHours: 3 };

/**
 * A variant as the plan would have written it, verdicts included.
 *
 * The verdicts are computed the same way the plan computes them, so a test can
 * ask whether re-deciding reproduces them rather than asserting hand-copied
 * numbers that would drift.
 */
const variant = (id: string, hours: number, km: number): PlanRideVariant => ({
  id,
  label: id,
  profile: "trekking",
  rank: 1,
  alternative: 0,
  km,
  ascentMetres: 400,
  surfaceKm: { paved: km, unpaved: 0, unknown: 0 },
  hours,
  brouterHours: hours,
  days: 1,
  feasible: true,
  verdict: "fits",
  slackHours: 0,
  neededBudgetHours: null,
  stages: [],
  geometry: [],
  gpx: null,
  elevationFile: null,
});

describe("judge", () => {
  const ways = [variant("quiet", 6.5, 95), variant("direct", 5, 80)];

  it("puts the quickest way home first, whatever order they arrived in", () => {
    expect(judge(ways, 1, budget).variants.map((v) => v.id)).toEqual(["direct", "quiet"]);
  });

  it("says a station works when any way home fits the day", () => {
    // 1h on the train and a 5h ride is 6h of a 10h day.
    const verdict = judge(ways, 1, budget);
    expect(verdict.feasible).toBe(true);
    expect(verdict.variants.map((v) => v.feasible)).toEqual([true, true]);
  });

  it("keeps the ways home that do not fit, alongside the ones that do", () => {
    // 7h day: the direct route fits with an hour spare, the quiet one overruns.
    const verdict = judge(ways, 1, { ...budget, budgetHours: 7 });
    expect(verdict.variants.map((v) => v.feasible)).toEqual([true, false]);
    expect(verdict.variants[1]!.verdict).toBe("overruns");
    expect(verdict.variants[1]!.neededBudgetHours).toBeCloseTo(7.5, 6);
  });

  it("reports what an overrunning station would need, by its quickest way home", () => {
    const verdict = judge(ways, 1, { ...budget, budgetHours: 5 });
    expect(verdict.feasible).toBe(false);
    // 1h on the train and a 5h direct ride wants a 6h day.
    expect(verdict.neededBudgetHours).toBeCloseTo(6, 6);
  });

  it("calls a place too short by its most direct way home, not its longest", () => {
    // Dawdling home by a longer route does not make a nearby town a trip you
    // needed a train for.
    expect(judge(ways, 1, { ...budget, minHours: 5.5 }).tooShort).toBe(true);
    expect(judge(ways, 1, budget).tooShort).toBe(false);
  });

  it("says nothing about a station with no routed ride rather than inventing one", () => {
    const verdict = judge([], 1, budget);
    expect(verdict.variants).toEqual([]);
    expect(verdict.feasible).toBe(false);
    expect(verdict.tooShort).toBe(false);
    expect(verdict.neededBudgetHours).toBeNull();
  });

  it("narrows what fits as the day shrinks, and never widens it", () => {
    let previous = Infinity;
    for (const budgetHours of [10, 9, 8, 7, 6, 5, 4]) {
      const fitting = judge(ways, 1, { ...budget, budgetHours }).variants.filter((v) => v.feasible);
      expect(fitting.length).toBeLessThanOrEqual(previous);
      previous = fitting.length;
    }
    expect(previous).toBe(0);
  });
});

describe("re-deciding at the settings a ride was measured with", () => {
  /**
   * The invariant the whole panel rests on: recomputing with the budget the plan
   * was built with must reproduce the plan, not approximate it. Anything else
   * means the sliders quietly show a different app than the one that made the
   * file, and the difference would only ever be noticed as numbers that move
   * when nothing was touched.
   */
  it("reproduces every verdict the plan baked in", () => {
    const day: Budget = { budgetHours: 9, maxDays: 2, hoursPerDay: 6, minHours: 2 };
    const spread = [1, 2.5, 3, 4.5, 6, 7.5, 9, 11];

    for (const [i, hours] of spread.entries()) {
      const trainHours = hours / 3;
      const first = judge([variant(`S${i}`, hours, hours * 16)], trainHours, day);
      // Feeding the result back in must change nothing: the verdicts it wrote
      // are the verdicts it reads.
      const again = judge(first.variants, trainHours, day);
      expect(again).toEqual(first);
    }
  });
});
