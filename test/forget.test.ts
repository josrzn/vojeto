import { describe, expect, it } from "vitest";
import {
  cachedStations,
  forgetRides,
  matchStations,
  orphanedFiles,
} from "../src/build/forget.js";
import type { Plan, PlanRideVariant } from "../src/build/buildPlan.js";

const variant = (id: string, files = true): PlanRideVariant =>
  ({
    id,
    label: id,
    profile: "trekking",
    rank: 1,
    alternative: 0,
    km: 40,
    ascentMetres: 300,
    surfaceKm: { paved: 40, unpaved: 0, unknown: 0 },
    hours: 2.5,
    brouterHours: 2.5,
    days: 1,
    feasible: true,
    verdict: "fits",
    slackHours: 1,
    neededBudgetHours: null,
    stages: [],
    geometry: [],
    gpx: files ? `${id}.gpx` : null,
    elevationFile: files ? `${id}.json` : null,
  }) as PlanRideVariant;

const plan = {
  rides: {
    SA_TARARE: [variant("tarare-trekking"), variant("tarare-gravel")],
    SA_STET: [variant("stet-trekking")],
    SA_GONE: [variant("gone-trekking")],
  },
  months: [
    {
      key: "2026-09",
      label: "September 2026",
      date: "2026-09-12",
      destinations: [
        { stationId: "SA_TARARE", name: "Tarare" },
        { stationId: "SA_STET", name: "Saint-Étienne Châteaucreux" },
      ],
    },
  ],
  rejected: [],
} as unknown as Plan;

describe("cachedStations", () => {
  it("names what it can and still lists what it cannot", () => {
    // SA_GONE has rides but no longer appears in any month — a station the
    // timetable has moved on from. It is in the cache, so it stays forgettable.
    expect(cachedStations(plan)).toEqual([
      { stationId: "SA_GONE", name: "SA_GONE", variants: 1 },
      { stationId: "SA_STET", name: "Saint-Étienne Châteaucreux", variants: 1 },
      { stationId: "SA_TARARE", name: "Tarare", variants: 2 },
    ]);
  });

  it("has nothing to say about a plan with no rides", () => {
    expect(cachedStations({ rides: {} } as unknown as Plan)).toEqual([]);
  });
});

describe("matchStations", () => {
  const stations = cachedStations(plan);

  it("matches a name loosely, ignoring case and accents", () => {
    expect(matchStations(stations, ["saint-etienne"]).matched.map((s) => s.stationId))
      .toEqual(["SA_STET"]);
    expect(matchStations(stations, ["TARARE"]).matched.map((s) => s.stationId))
      .toEqual(["SA_TARARE"]);
  });

  it("matches a station id exactly, which is what the plan actually writes down", () => {
    expect(matchStations(stations, ["SA_GONE"]).matched.map((s) => s.stationId))
      .toEqual(["SA_GONE"]);
  });

  it("takes every station a query names", () => {
    // Reversible by re-running the planner, so being eager costs a rebuild
    // while being timid costs a puzzle about why nothing happened.
    expect(matchStations(stations, ["a"]).matched.length).toBeGreaterThan(1);
  });

  it("names a query that matched nothing rather than failing silently", () => {
    const { matched, unmatched } = matchStations(stations, ["nowhere", "tarare"]);
    expect(unmatched).toEqual(["nowhere"]);
    expect(matched.map((s) => s.stationId)).toEqual(["SA_TARARE"]);
  });

  it("counts a station named twice only once", () => {
    expect(matchStations(stations, ["tarare", "SA_TARARE"]).matched).toHaveLength(1);
  });

  it("ignores an empty query rather than matching everything", () => {
    expect(matchStations(stations, ["", "   "])).toEqual({ matched: [], unmatched: [] });
  });
});

describe("orphanedFiles", () => {
  it("lists the files only the forgotten rides pointed at", () => {
    expect(orphanedFiles(plan, new Set(["SA_TARARE"]))).toEqual({
      gpx: ["tarare-trekking.gpx", "tarare-gravel.gpx"],
      profiles: ["tarare-trekking.json", "tarare-gravel.json"],
    });
  });

  it("keeps a file a remaining ride still points at", () => {
    // Should never happen — the names carry the station — but deleting a file
    // something still reads would surface much later as a chart that will not
    // load, and the check costs nothing.
    const shared = {
      rides: { A: [variant("same")], B: [variant("same")] },
    } as unknown as Plan;
    expect(orphanedFiles(shared, new Set(["A"]))).toEqual({ gpx: [], profiles: [] });
  });

  it("has nothing to delete for rides that were never written to disk", () => {
    const routedInThePage = {
      rides: { A: [variant("x", false)] },
    } as unknown as Plan;
    expect(orphanedFiles(routedInThePage, new Set(["A"]))).toEqual({ gpx: [], profiles: [] });
  });
});

describe("forgetRides", () => {
  it("drops those stations and leaves the rest of the plan alone", () => {
    const after = forgetRides(plan, new Set(["SA_TARARE", "SA_GONE"]));
    expect(Object.keys(after.rides)).toEqual(["SA_STET"]);
    // The field, the months, the settings: all about the place rather than one
    // road home, and none of it worth throwing away to re-ask for a route.
    expect(after.months).toBe(plan.months);
    expect(plan.rides["SA_TARARE"]).toHaveLength(2);
  });

  it("empties the cache when everything is forgotten", () => {
    const ids = new Set(Object.keys(plan.rides));
    expect(forgetRides(plan, ids).rides).toEqual({});
  });
});
