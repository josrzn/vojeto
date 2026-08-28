import { describe, expect, it } from "vitest";
import { explore, quickestTrains, sameHome, searchStations, type Home } from "../web/src/explore.js";
import { TOURING_CURVES } from "../src/bike/speed.js";
import type { Budget } from "../src/bike/effort.js";
import type { Itinerary } from "../src/shared/types.js";

const budget: Budget = { budgetHours: 10, maxDays: 1, hoursPerDay: 6, minHours: 3 };
const effort = { curves: TOURING_CURVES };
const ROANNE = { lat: 46.034389, lon: 4.079342 };

const itinerary = (name: string, lat: number, lon: number, hours: number): Itinerary => ({
  destination: name,
  destinationName: name,
  lat,
  lon,
  departure: 6 * 3600,
  arrival: 6 * 3600 + hours * 3600,
  duration: hours * 3600,
  transfers: 0,
  legs: [
    {
      calls: [{ name: "Roanne", lat: 46.03, lon: 4.07 }, { name, lat, lon }],
      fromStop: "SA_ROANNE",
      fromName: "Roanne",
      toStop: name,
      toName: name,
      departure: 6 * 3600,
      arrival: 6 * 3600 + hours * 3600,
      routeName: "a line",
      headsign: "886917",
      tripId: `T_${name}`,
    },
  ],
});

describe("explore", () => {
  it("keeps a station the hours left could cover", () => {
    // 40 km away with an hour on the train: nine hours of riding is ample.
    const near = itinerary("Near", 46.3, 4.2, 1);
    const { destinations, outOfRange } = explore([near], ROANNE, budget, effort);
    expect(destinations.map((d) => d.name)).toEqual(["Near"]);
    expect(outOfRange).toBe(0);
  });

  it("drops one no ride could reach, without routing to find out", () => {
    // Brittany, from Roanne. No road exists that a day could cover.
    const far = itinerary("Lorient", 47.748, -3.366, 3);
    const { destinations, outOfRange } = explore([far], ROANNE, budget, effort);
    expect(destinations).toEqual([]);
    expect(outOfRange).toBe(1);
  });

  it("shrinks the reach as the train journey lengthens", () => {
    const at = { lat: 46.9, lon: 4.9 };
    const quick = explore([itinerary("X", at.lat, at.lon, 1)], ROANNE, budget, effort);
    const slow = explore([itinerary("X", at.lat, at.lon, 9)], ROANNE, budget, effort);
    expect(quick.destinations).toHaveLength(1);
    expect(slow.destinations).toHaveLength(0);
  });

  it("never drops a station a ride could actually have reached", () => {
    // The bound must be a superset: the straight line is never longer than the
    // road, so anything inside the budget is inside the circle.
    for (const km of [10, 50, 100, 140]) {
      const north = { lat: ROANNE.lat + km / 111, lon: ROANNE.lon };
      const { destinations } = explore([itinerary("N", north.lat, north.lon, 1)], ROANNE, budget, effort);
      // Nine hours left at 16 km/h flat covers 144 km.
      if (km <= 140) expect(destinations).toHaveLength(1);
    }
  });

  it("skips an itinerary with no position rather than placing it at zero", () => {
    const nowhere = itinerary("Nowhere", Number.NaN, Number.NaN, 1);
    expect(explore([nowhere], ROANNE, budget, effort).destinations).toEqual([]);
  });

  it("builds destinations the way the planner does", () => {
    const [destination] = explore([itinerary("Near", 46.3, 4.2, 1)], ROANNE, budget, effort).destinations;
    expect(destination!.travel).toBe("1h00");
    expect(destination!.departure).toBe("06:00");
    expect(destination!.corridor).toBe("a line");
    // A numeric headsign is a train number in this feed, not a destination.
    expect(destination!.legs[0]!.trainNumber).toBe("886917");
    expect(destination!.legs[0]!.towards).toBe("");
  });
});

describe("quickestTrains", () => {
  it("keeps the quickest journey to each station", () => {
    const { destinations } = explore(
      [itinerary("A", 46.3, 4.2, 2), itinerary("A", 46.3, 4.2, 1), itinerary("B", 46.4, 4.3, 3)],
      ROANNE,
      budget,
      effort,
    );
    expect(quickestTrains(destinations)).toEqual({ A: 1, B: 3 });
  });
});

describe("sameHome", () => {
  const home: Home = { stationId: "A", name: "A", at: ROANNE, rideTo: ROANNE };

  it("is the same place after a round trip through JSON", () => {
    expect(sameHome(home, JSON.parse(JSON.stringify(home)) as Home)).toBe(true);
  });

  it("notices a different station or a moved doorway", () => {
    expect(sameHome(home, { ...home, stationId: "B" })).toBe(false);
    expect(sameHome(home, { ...home, rideTo: { lat: 46.04, lon: 4.08 } })).toBe(false);
  });

  it("ignores a difference far below what the router would round off", () => {
    expect(sameHome(home, { ...home, rideTo: { lat: ROANNE.lat + 1e-9, lon: ROANNE.lon } })).toBe(true);
  });

  it("handles nothing being picked yet", () => {
    expect(sameHome(null, null)).toBe(true);
    expect(sameHome(home, null)).toBe(false);
  });
});

describe("searchStations", () => {
  const stations = [
    { id: "1", name: "Lyon Part-Dieu" },
    { id: "2", name: "Lyon Perrache" },
    { id: "3", name: "Bellegarde-sur-Valserine (Lyon)" },
    { id: "4", name: "Roanne" },
    { id: "5", name: "Saint-Étienne Châteaucreux" },
  ];

  it("puts a name that starts with what you typed first", () => {
    expect(searchStations(stations, "lyon").map((s) => s.name)).toEqual([
      "Lyon Part-Dieu",
      "Lyon Perrache",
      "Bellegarde-sur-Valserine (Lyon)",
    ]);
  });

  it("needs every word, in any order", () => {
    expect(searchStations(stations, "dieu lyon").map((s) => s.id)).toEqual(["1"]);
    expect(searchStations(stations, "lyon nowhere")).toEqual([]);
  });

  it("ignores case and stray spaces", () => {
    expect(searchStations(stations, "  ROANNE ").map((s) => s.id)).toEqual(["4"]);
  });

  it("offers the start of the list before anything is typed", () => {
    expect(searchStations(stations, "", 2)).toHaveLength(2);
    expect(searchStations(stations, "   ", 2)).toHaveLength(2);
  });

  it("stops at the limit rather than returning thousands", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), name: `Gare ${i}` }));
    expect(searchStations(many, "gare", 25)).toHaveLength(25);
  });
});
