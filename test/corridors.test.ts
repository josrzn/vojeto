import { describe, expect, it } from "vitest";
import {
  bestVariant,
  formatHours,
  formatHoursCeil,
  groupIntoCorridors,
} from "../web/src/corridors.js";
import type { PlanDestination, PlanRideVariant } from "../src/build/buildPlan.js";

const destination = (
  name: string,
  corridor: string,
  travelMinutes: number,
): PlanDestination => ({
  stationId: name,
  name,
  lat: 46,
  lon: 4,
  departure: "07:00",
  arrival: "08:00",
  travel: "1h00",
  travelMinutes,
  transfers: 0,
  legs: [],
  worstWaitMinutes: 0,
  corridor,
});

const variant = (km: number, feasible = true, id = "trekking"): PlanRideVariant => ({
  id,
  label: "Quiet roads",
  profile: "trekking",
  alternative: 0,
  km,
  ascentMetres: 400,
  hours: km / 16,
  brouterHours: km / 18,
  days: 1,
  feasible,
  verdict: feasible ? "fits" : "overruns",
  slackHours: feasible ? 1 : -1,
  neededBudgetHours: feasible ? null : 9,
  stages: [],
  geometry: [],
  gpx: feasible ? "test.gpx" : null,
});

describe("bestVariant", () => {
  it("prefers the first variant that fits", () => {
    const variants = [variant(90, false, "a"), variant(60, true, "b")];
    expect(bestVariant(variants)?.id).toBe("b");
  });

  it("falls back to the first when none fit, so the near miss is still visible", () => {
    expect(bestVariant([variant(90, false, "a"), variant(95, false, "b")])?.id).toBe("a");
  });

  it("handles a station with no routes", () => {
    expect(bestVariant(undefined)).toBeNull();
    expect(bestVariant([])).toBeNull();
  });
});

describe("groupIntoCorridors", () => {
  const destinations = [
    destination("Tarare", "Lyon line", 34),
    destination("Amplepuis", "Lyon line", 23),
    destination("L'Arbresle", "Lyon line", 47),
    destination("Feurs", "Saint-Étienne line", 33),
  ];
  const rides: Record<string, PlanRideVariant[]> = {
    Tarare: [variant(35)],
    Amplepuis: [variant(26)],
    "L'Arbresle": [variant(49)],
    Feurs: [variant(38)],
  };

  it("groups stations by the line of the final leg", () => {
    const corridors = groupIntoCorridors(destinations, rides);
    expect(corridors.map((c) => c.name)).toEqual(["Lyon line", "Saint-Étienne line"]);
    expect(corridors[0]!.destinations).toHaveLength(3);
  });

  it("orders stations within a corridor by ride length, making a difficulty ladder", () => {
    const [lyon] = groupIntoCorridors(destinations, rides);
    expect(lyon!.destinations.map((d) => d.name)).toEqual(["Amplepuis", "Tarare", "L'Arbresle"]);
  });

  it("reports the range of rides a corridor offers", () => {
    const [lyon] = groupIntoCorridors(destinations, rides);
    expect(lyon!.shortestRideKm).toBe(26);
    expect(lyon!.longestRideKm).toBe(49);
    expect(lyon!.quickestTrainMinutes).toBe(23);
    expect(lyon!.slowestTrainMinutes).toBe(47);
  });

  it("puts the corridor with the shortest ride first", () => {
    const corridors = groupIntoCorridors(destinations, rides);
    expect(corridors[0]!.name).toBe("Lyon line");
  });

  it("copes with stations that have no ride yet", () => {
    const corridors = groupIntoCorridors(destinations, {});
    expect(corridors).toHaveLength(2);
    expect(Number.isNaN(corridors[0]!.shortestRideKm)).toBe(true);
  });

  it("falls back to the station name when the feed gives no line", () => {
    const corridors = groupIntoCorridors([destination("Lone", "", 20)], {});
    expect(corridors[0]!.name).toBe("Lone");
  });
});

describe("formatHours", () => {
  it("writes hours and minutes the way a timetable would", () => {
    expect(formatHours(4)).toBe("4h00");
    expect(formatHours(4.5)).toBe("4h30");
    expect(formatHours(0.25)).toBe("0h15");
  });

  it("carries a rounded 60 minutes into the next hour", () => {
    expect(formatHours(3.999)).toBe("4h00");
  });
});

describe("formatHoursCeil", () => {
  it("never rounds down, so a needed budget is never reported as one you have", () => {
    // 8.0001 h against an 8 h budget must not read back as "8h00".
    expect(formatHoursCeil(8.0001)).toBe("8h01");
    expect(formatHoursCeil(8)).toBe("8h00");
  });

  it("agrees with formatHours on exact minutes", () => {
    for (const hours of [0, 0.25, 1.5, 4, 9.5]) {
      expect(formatHoursCeil(hours)).toBe(formatHours(hours));
    }
  });

  it("handles a non-finite value rather than printing NaN", () => {
    expect(formatHoursCeil(Infinity)).toBe("—");
  });
});
