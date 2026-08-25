import { describe, expect, it } from "vitest";
import { fitsBudget, maxRideKm, rideHours, type Budget, type EffortModel } from "../src/bike/effort.js";

const model: EffortModel = { speedKmh: 16, climbMetresPerHour: 600 };
const dayTrip: Budget = { budgetHours: 6, maxDays: 1, hoursPerDay: 6 };

describe("rideHours", () => {
  it("adds a climbing allowance to the flat time", () => {
    expect(rideHours(48, 0, model)).toBeCloseTo(3, 6);
    expect(rideHours(48, 600, model)).toBeCloseTo(4, 6);
  });

  it("treats a flat route as pure distance", () => {
    expect(rideHours(80, 0, model)).toBeCloseTo(5, 6);
  });

  it("ignores climbing when the allowance is switched off", () => {
    expect(rideHours(48, 1200, { speedKmh: 16, climbMetresPerHour: 0 })).toBeCloseTo(3, 6);
  });
});

describe("fitsBudget", () => {
  it("fits a short ride into what is left of the day", () => {
    // 1h on the train leaves 5h; a 3h ride fits with 2h to spare.
    const result = fitsBudget(1, 3, dayTrip);
    expect(result).toEqual({ feasible: true, days: 1, slackHours: 2 });
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
    const twoDays: Budget = { budgetHours: 6, maxDays: 2, hoursPerDay: 6 };
    // 1h train leaves 5h on day one; 9h of riding needs 4h more, so two days.
    expect(fitsBudget(1, 9, twoDays)).toEqual({ feasible: true, days: 2, slackHours: 2 });
  });

  it("reports the days needed even when they exceed the limit", () => {
    const result = fitsBudget(1, 20, { budgetHours: 6, maxDays: 2, hoursPerDay: 6 });
    expect(result.feasible).toBe(false);
    expect(result.days).toBe(4);
  });

  it("uses the exact boundary inclusively", () => {
    expect(fitsBudget(1, 5, dayTrip)).toEqual({ feasible: true, days: 1, slackHours: 0 });
  });
});

describe("maxRideKm", () => {
  it("bounds a day trip by the hours left after the train", () => {
    expect(maxRideKm(1, dayTrip, model)).toBeCloseTo(80, 6);
  });

  it("adds the later days when multi-day is allowed", () => {
    expect(maxRideKm(1, { budgetHours: 6, maxDays: 3, hoursPerDay: 6 }, model)).toBeCloseTo(272, 6);
  });

  it("is zero when the train already exhausts the budget", () => {
    expect(maxRideKm(7, dayTrip, model)).toBe(0);
  });

  it("never bounds below what fitsBudget would accept", () => {
    // The bound ignores climbing, so it must not be tighter than the real check.
    for (const trainHours of [0.5, 1, 2, 3]) {
      const km = maxRideKm(trainHours, dayTrip, model);
      expect(fitsBudget(trainHours, rideHours(km, 0, model), dayTrip).feasible).toBe(true);
      expect(fitsBudget(trainHours, rideHours(km + 1, 0, model), dayTrip).feasible).toBe(false);
    }
  });
});
