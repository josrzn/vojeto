import { describe, expect, it } from "vitest";
import { reckon } from "../web/src/budget.js";
import type { Budget } from "../src/bike/effort.js";
import type { PlanDestination, PlanRideVariant } from "../src/build/buildPlan.js";

const built: Budget = { budgetHours: 10, maxDays: 1, hoursPerDay: 6, minHours: 3 };

const destination = (stationId: string, travelMinutes: number): PlanDestination => ({
  stationId,
  name: stationId,
  lat: 46,
  lon: 4,
  departure: "07:00",
  arrival: "08:00",
  travel: "1h00",
  travelMinutes,
  transfers: 0,
  legs: [],
  worstWaitMinutes: 0,
  corridor: "line",
});

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

describe("reckon", () => {
  const destinations = [destination("A", 60), destination("B", 120), destination("C", 90)];
  const rides: Record<string, PlanRideVariant[]> = {
    A: [variant("direct", 5, 80), variant("quiet", 6.5, 95)],
    B: [variant("direct", 4, 65)],
    C: [variant("direct", 2, 30)],
  };
  const trainHours = { A: 1, B: 2, C: 1.5 };

  it("keeps what fits and drops what does not", () => {
    const { destinations: kept, rejected } = reckon(destinations, rides, trainHours, built);
    // A: 1h train + 5h ride = 6h, fits in 10. B: 2 + 4 = 6, fits.
    // C: a 2h ride is under minHours, so it is not a trip worth a ticket.
    expect(kept.map((d) => d.stationId)).toEqual(["A", "B"]);
    expect(rejected.map((r) => r.stationId)).toEqual(["C"]);
    expect(rejected[0]!.verdict).toBe("tooShort");
  });

  it("judges a station by its most direct way home, not its longest", () => {
    // A's quiet route is 6.5h; its direct one is 5h and clears minHours. Raising
    // minHours past the direct route should drop the station outright.
    const strict = { ...built, minHours: 5.5 };
    const { destinations: kept } = reckon(destinations, rides, trainHours, strict);
    expect(kept.map((d) => d.stationId)).toEqual([]);
  });

  it("keeps the ways home that do not fit, alongside the ones that do", () => {
    // 7h budget: A's direct route fits with 1h to spare, its quiet one overruns.
    const tight = { ...built, budgetHours: 7 };
    const { rides: judged } = reckon(destinations, rides, trainHours, tight);
    expect(judged["A"]!.map((v) => v.feasible)).toEqual([true, false]);
    expect(judged["A"]![1]!.verdict).toBe("overruns");
    expect(judged["A"]![1]!.neededBudgetHours).toBeCloseTo(7.5, 6);
  });

  it("narrows the list as the budget shrinks, and never grows it", () => {
    let previous = Infinity;
    for (const budgetHours of [10, 9, 8, 7, 6, 5]) {
      const { destinations: kept } = reckon(destinations, rides, trainHours, {
        ...built,
        budgetHours,
      });
      expect(kept.length).toBeLessThanOrEqual(previous);
      previous = kept.length;
    }
    expect(previous).toBe(0);
  });

  it("uses the shipped train time, not the month on screen", () => {
    // B's month shows a 2h journey but the plan judged it on a quicker one.
    // Changing the month must not change what fits.
    const slowerMonth = [destination("B", 240)];
    const onQuick = reckon(slowerMonth, rides, { B: 2 }, built);
    const onSlow = reckon(slowerMonth, rides, { B: 2 }, built);
    expect(onQuick.destinations).toEqual(onSlow.destinations);

    // And with no shipped figure it falls back to the month rather than failing.
    const fallback = reckon([destination("B", 120)], rides, {}, built);
    expect(fallback.destinations.map((d) => d.stationId)).toEqual(["B"]);
  });

  it("reports what an overrunning station would need", () => {
    const tight = { ...built, budgetHours: 5 };
    const { rejected } = reckon(destinations, rides, trainHours, tight);
    const a = rejected.find((r) => r.stationId === "A")!;
    // 1h on the train and a 5h direct ride wants a 6h day.
    expect(a.verdict).toBe("overruns");
    expect(a.neededBudgetHours).toBeCloseTo(6, 6);
  });

  it("passes over a station with no routed ride rather than inventing one", () => {
    const { destinations: kept, rejected } = reckon(
      [destination("Z", 60)],
      {},
      { Z: 1 },
      built,
    );
    expect(kept).toEqual([]);
    expect(rejected).toEqual([]);
  });
});

describe("re-deciding at the built settings", () => {
  /**
   * The invariant the whole panel rests on: recomputing with the budget the plan
   * was built with must reproduce the plan, not approximate it. Anything else
   * means the sliders quietly show a different app than the one that made the
   * file, and the difference would only ever be noticed as numbers that move
   * when nothing was touched.
   */
  it("reproduces every verdict the plan baked in", () => {
    const budget: Budget = { budgetHours: 9, maxDays: 2, hoursPerDay: 6, minHours: 2 };
    const spread = [1, 2.5, 3, 4.5, 6, 7.5, 9, 11];
    const destinations = spread.map((h, i) => destination(`S${i}`, h * 60));
    const trainHours = Object.fromEntries(spread.map((h, i) => [`S${i}`, h / 3]));
    const rides = Object.fromEntries(
      spread.map((h, i) => [`S${i}`, [variant("direct", h, h * 16)]]),
    );

    const first = reckon(destinations, rides, trainHours, budget);
    // Feeding the result back in must change nothing: the verdicts it wrote are
    // the verdicts it reads.
    const again = reckon(first.destinations, first.rides, trainHours, budget);
    expect(again.destinations).toEqual(first.destinations);
    expect(again.rides).toEqual(first.rides);
    expect(again.rejected).toEqual([]);
  });
});
