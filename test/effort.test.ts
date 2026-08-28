import { describe, expect, it } from "vitest";
import { fitsBudget, maxRideKm, rideHours, type Budget, type EffortModel } from "../src/bike/effort.js";
import { curveFromLinearModel, flatKmh } from "../src/bike/speed.js";
import type { Surface } from "../src/bike/surface.js";

/** One curve for every surface, i.e. gradient modelled and surface not. */
const everywhere = (curve: ReturnType<typeof curveFromLinearModel>): EffortModel => ({
  curves: { paved: curve, unpaved: curve, unknown: curve },
});

const model: EffortModel = everywhere(curveFromLinearModel(16, 600));

/** A profile of `km` at a steady gradient, as the model now wants its input. */
const slope = (km: number, ascentMetres: number) => ({
  km: [0, km],
  ele: [0, ascentMetres],
});
const hoursFor = (
  km: number,
  ascentMetres: number,
  m: EffortModel = model,
  surface: Surface = "paved",
) => {
  const { km: xs, ele } = slope(km, ascentMetres);
  return rideHours(xs, ele, [surface, surface], m);
};
const dayTrip: Budget = { budgetHours: 6, maxDays: 1, hoursPerDay: 6, minHours: 0 };

describe("rideHours", () => {
  it("treats a flat route as pure distance", () => {
    expect(hoursFor(80, 0)).toBeCloseTo(5, 6);
    expect(hoursFor(48, 0)).toBeCloseTo(3, 6);
  });

  it("charges for climbing", () => {
    // 48 km gaining 600 m is a steady 1.25%, well under the flat speed.
    expect(hoursFor(48, 600)).toBeGreaterThan(hoursFor(48, 0));
  });

  it("reproduces the old flat-plus-climbing model it was derived from", () => {
    // curveFromLinearModel exists so an old config keeps its numbers: 48 km and
    // 600 m of climb was exactly 4 hours at 16 km/h plus 600 m/h. The curve
    // interpolates between anchors, so it is close rather than equal — the
    // promise is "within half a percent", not "identical".
    expect(hoursFor(48, 600)).toBeCloseTo(4, 1);
    expect(Math.abs(hoursFor(48, 600) - 4) / 4).toBeLessThan(0.005);
  });

  it("stays within half a percent of the old model across real gradients", () => {
    for (let gradient = 0; gradient <= 12; gradient += 0.25) {
      const km = 20;
      const exact = km / 16 + (10 * gradient * km) / 600;
      expect(Math.abs(hoursFor(km, 10 * gradient * km) - exact) / exact).toBeLessThan(0.005);
    }
  });

  it("is faster downhill than on the flat, which the old model never was", () => {
    const curve = everywhere(curveFromLinearModel(16, 600));
    // The derived curve inherits the old model's flat descents...
    expect(hoursFor(48, -600, curve)).toBeCloseTo(hoursFor(48, 0, curve), 6);
    // ...while a curve with real descending speeds does not.
    const descends: EffortModel = everywhere([
      { gradient: -5, kmh: 30 },
      { gradient: 0, kmh: 16 },
      { gradient: 5, kmh: 8 },
    ]);
    expect(hoursFor(48, -600, descends)).toBeLessThan(hoursFor(48, 0, descends));
  });
});

describe("fitsBudget", () => {
  it("fits a short ride into what is left of the day", () => {
    // 1h on the train leaves 5h; a 3h ride fits with 2h to spare.
    const result = fitsBudget(1, 3, dayTrip);
    expect(result).toEqual({
      feasible: true,
      verdict: "fits",
      days: 1,
      slackHours: 2,
      neededBudgetHours: null,
    });
  });

  it("rejects a ride that overruns a single day", () => {
    const result = fitsBudget(1, 6, dayTrip);
    expect(result.feasible).toBe(false);
    expect(result.slackHours).toBeCloseTo(-1, 6);
  });

  it("rejects a train journey that eats the whole budget", () => {
    expect(fitsBudget(6.5, 1, dayTrip).feasible).toBe(false);
    expect(fitsBudget(6, 0.5, dayTrip).feasible).toBe(false);
  });

  it("spreads a long ride over the days allowed", () => {
    const twoDays: Budget = { budgetHours: 6, maxDays: 2, hoursPerDay: 6, minHours: 0 };
    // 1h train leaves 5h on day one; 9h of riding needs 4h more, so two days.
    expect(fitsBudget(1, 9, twoDays)).toEqual({
      feasible: true,
      verdict: "fits",
      days: 2,
      slackHours: 2,
      neededBudgetHours: null,
    });
  });

  it("reports the days needed even when they exceed the limit", () => {
    const result = fitsBudget(1, 20, { budgetHours: 6, maxDays: 2, hoursPerDay: 6, minHours: 0 });
    expect(result.feasible).toBe(false);
    expect(result.days).toBe(4);
  });

  /**
   * "Infinity days" reached the screen from here: the overrun case used it to
   * mean "no number of days you have allowed will do". True of the verdict,
   * useless as a number, and the panel printed it verbatim.
   */
  it("always says how many days a ride would take, as a number", () => {
    const cases: Array<[number, number, Budget]> = [
      [1, 6, dayTrip],
      [6.5, 1, dayTrip],
      [2, 8.4, { budgetHours: 10, maxDays: 1, hoursPerDay: 6, minHours: 3 }],
      [1, 20, { budgetHours: 6, maxDays: 2, hoursPerDay: 6, minHours: 0 }],
      [1, 9, { budgetHours: 6, maxDays: 1, hoursPerDay: 0, minHours: 0 }],
    ];
    for (const [trainHours, hours, budget] of cases) {
      const result = fitsBudget(trainHours, hours, budget);
      expect(Number.isFinite(result.days)).toBe(true);
      expect(result.days).toBeGreaterThanOrEqual(1);
    }
  });

  it("calls a one-day trip one day, even when it overruns", () => {
    // The ride you were shown is a single day that is 25 minutes too long, not
    // an unbounded expedition.
    const day = { budgetHours: 10, maxDays: 1, hoursPerDay: 6, minHours: 3 };
    const result = fitsBudget(2.07, 8.35, day);
    expect(result.feasible).toBe(false);
    expect(result.days).toBe(1);
  });

  it("uses the exact boundary inclusively", () => {
    expect(fitsBudget(1, 5, dayTrip)).toEqual({
      feasible: true,
      verdict: "fits",
      days: 1,
      slackHours: 0,
      neededBudgetHours: null,
    });
  });
});

describe("fitsBudget with a minimum worth-the-fare ride", () => {
  const worthIt = { budgetHours: 8, maxDays: 1, hoursPerDay: 6, minHours: 3 };

  it("rejects a ride too short to justify the train", () => {
    const result = fitsBudget(0.5, 2, worthIt);
    expect(result.feasible).toBe(false);
    expect(result.verdict).toBe("tooShort");
  });

  it("accepts one exactly at the minimum", () => {
    expect(fitsBudget(0.5, 3, worthIt).verdict).toBe("fits");
  });

  it("does not rescue a short ride by having time to spare", () => {
    // Masses of budget left, still not a trip worth taking the train for.
    expect(fitsBudget(0.1, 1, worthIt).verdict).toBe("tooShort");
  });

  it("does not rescue a short ride by spreading it over days", () => {
    const multiDay = { budgetHours: 8, maxDays: 3, hoursPerDay: 6, minHours: 3 };
    expect(fitsBudget(0.5, 2, multiDay).verdict).toBe("tooShort");
  });

  it("reports no needed budget for a ride that is merely too short", () => {
    expect(fitsBudget(0.5, 2, worthIt).neededBudgetHours).toBeNull();
  });
});

describe("fitsBudget reporting the budget a trip would need", () => {
  const dayTrip8: Budget = { budgetHours: 8, maxDays: 1, hoursPerDay: 6, minHours: 0 };

  it("gives the total a too-long trip would take", () => {
    // 1.2 h on the train plus 7.9 h riding wants a 9.1 h day.
    const result = fitsBudget(1.2, 7.9, dayTrip8);
    expect(result.verdict).toBe("overruns");
    expect(result.neededBudgetHours).toBeCloseTo(9.1, 6);
  });

  it("gives a figure that would actually let the trip in", () => {
    const result = fitsBudget(1.2, 7.9, dayTrip8);
    const raised = { ...dayTrip8, budgetHours: result.neededBudgetHours! };
    expect(fitsBudget(1.2, 7.9, raised).feasible).toBe(true);
  });

  it("reports it even when the train alone exhausts the budget", () => {
    const result = fitsBudget(9, 1, dayTrip8);
    expect(result.verdict).toBe("overruns");
    expect(result.neededBudgetHours).toBeCloseTo(10, 6);
  });

  it("counts the days a multi-day ride would need when it exceeds the limit", () => {
    const result = fitsBudget(1, 20, { budgetHours: 6, maxDays: 2, hoursPerDay: 6, minHours: 0 });
    expect(result.verdict).toBe("overruns");
    expect(result.days).toBe(4);
  });
});

describe("maxRideKm", () => {
  // The bound carries deliberate slack, so these check what it is for — that it
  // sits above the flat-speed distance — rather than pinning its exact value.
  it("bounds a day trip by the hours left after the train", () => {
    // 1h on the train leaves 5h, which is 80 km at 16 km/h.
    const bound = maxRideKm(1, dayTrip, model);
    expect(bound).toBeGreaterThanOrEqual(80);
    expect(bound).toBeLessThan(80 * 1.25);
  });

  it("adds the later days when multi-day is allowed", () => {
    // 5h on day one plus two more days of 6h: 17h, or 272 km on the flat.
    const bound = maxRideKm(1, { budgetHours: 6, maxDays: 3, hoursPerDay: 6, minHours: 0 }, model);
    expect(bound).toBeGreaterThanOrEqual(272);
    expect(bound).toBeLessThan(272 * 1.25);
  });

  it("is zero when the train already exhausts the budget", () => {
    expect(maxRideKm(7, dayTrip, model)).toBe(0);
  });

  it("never bounds below what fitsBudget would accept", () => {
    // The bound is deliberately generous, so a flat ride of exactly that length
    // must still be rejected only by the budget, never by the bound.
    for (const trainHours of [0.5, 1, 2, 3]) {
      const km = maxRideKm(trainHours, dayTrip, model);
      const flatRide = km / flatKmh(model.curves.paved);
      expect(flatRide).toBeGreaterThan(dayTrip.budgetHours - trainHours);
      const longestThatFits = (dayTrip.budgetHours - trainHours) * flatKmh(model.curves.paved);
      expect(km).toBeGreaterThanOrEqual(longestThatFits);
    }
  });
});
