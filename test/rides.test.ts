import { describe, expect, it } from "vitest";
import { warmCache, withVariant } from "../web/src/rides.js";
import { preferred, stylesFrom, ROUTE_STYLES } from "../web/src/routeStyles.js";
import { profileFromPoints, profileFromTrack } from "../web/src/rideProfile.js";
import type { Home } from "../web/src/explore.js";
import type { Plan, PlanRideVariant } from "../src/build/buildPlan.js";
import type { BikeTrack } from "../src/bike/track.js";

const home: Home = {
  stationId: "SA_ROANNE",
  name: "Roanne",
  at: { lat: 46.0389, lon: 4.0656 },
  rideTo: { lat: 46.034389, lon: 4.079342 },
};

const variant = (id: string, hours = 3): PlanRideVariant => ({
  id,
  label: id,
  profile: "trekking",
  rank: 1,
  alternative: 0,
  km: hours * 16,
  ascentMetres: 300,
  surfaceKm: { paved: hours * 16, unpaved: 0, unknown: 0 },
  hours,
  brouterHours: hours,
  days: 1,
  feasible: true,
  verdict: "fits",
  slackHours: 1,
  neededBudgetHours: null,
  stages: [],
  geometry: [],
  gpx: null,
  elevationFile: null,
});

const plan = (rideTo = home.rideTo, stationId = home.stationId) =>
  ({
    settings: {},
    home: {
      station: { stationId, name: "Roanne", lat: 46.0389, lon: 4.0656 },
      rideTo,
    },
    rides: { SA_TARARE: [variant("trekking")] },
  }) as unknown as Plan;

describe("the plan as a warm cache", () => {
  it("hands over its rides when it was built for this very pair", () => {
    expect(warmCache(plan(), home)).toEqual({ SA_TARARE: [variant("trekking")] });
  });

  it("is ignored when the door has moved, because those roads end elsewhere", () => {
    expect(warmCache(plan(), { ...home, rideTo: { lat: 46.2, lon: 4.4 } })).toEqual({});
  });

  it("is ignored when the station has changed", () => {
    expect(warmCache(plan(home.rideTo, "SA_LYON"), home)).toEqual({});
  });

  it("is nothing at all when there is no plan, or nowhere to compare it to", () => {
    expect(warmCache(null, home)).toEqual({});
    expect(warmCache(plan(), null)).toEqual({});
  });
});

describe("withVariant", () => {
  it("adds a way home without disturbing the others", () => {
    const rides = { A: [variant("trekking")] };
    const next = withVariant(rides, "A", variant("gravel"));
    expect(next["A"]!.map((v) => v.id)).toEqual(["trekking", "gravel"]);
    // The old object is untouched, so React sees a new one and repaints.
    expect(rides["A"]).toHaveLength(1);
  });

  it("replaces a way home of the same kind rather than showing it twice", () => {
    const next = withVariant({ A: [variant("trekking", 3)] }, "A", variant("trekking", 4));
    expect(next["A"]).toHaveLength(1);
    expect(next["A"]![0]!.hours).toBe(4);
  });

  it("starts a station that had nothing", () => {
    expect(withVariant({}, "B", variant("trekking"))["B"]).toHaveLength(1);
  });
});

describe("the ways home on offer", () => {
  it("are config's when a plan shipped them", () => {
    const shipped = { settings: { variants: [{ id: "x", label: "X", profile: "p" }] } } as unknown as Plan;
    expect(stylesFrom(shipped)).toEqual([{ id: "x", label: "X", profile: "p" }]);
  });

  it("are the built-in list when there is no plan, or it shipped none", () => {
    expect(stylesFrom(null)).toEqual(ROUTE_STYLES);
    expect(stylesFrom({ settings: {} } as unknown as Plan)).toEqual(ROUTE_STYLES);
  });

  it("falls back to the first rather than to nothing when the preference is unknown", () => {
    expect(preferred(ROUTE_STYLES, "gravel").id).toBe("gravel");
    expect(preferred(ROUTE_STYLES, "no-such-thing")).toBe(ROUTE_STYLES[0]);
  });
});

describe("the chart's data", () => {
  // A kilometre east, climbing fifty metres, then a kilometre back down.
  const points = [
    [4.0, 46.0, 100],
    [4.0129, 46.0, 150],
    [4.0258, 46.0, 100],
  ];

  it("measures distance along the line and gradient across each step", () => {
    const profile = profileFromPoints(points);
    expect(profile.km[0]).toBe(0);
    expect(profile.km[2]).toBeCloseTo(2, 1);
    expect(profile.grade[1]).toBeCloseTo(5, 0);
    expect(profile.grade[2]).toBeCloseTo(-5, 0);
    expect(profile.at).toEqual([
      [4.0, 46.0],
      [4.0129, 46.0],
      [4.0258, 46.0],
    ]);
  });

  it("calls a surface unknown when the file did not record one", () => {
    expect(profileFromPoints(points).surface).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("reads the surface indices a plan's profile shipped", () => {
    // 0 is paved, 1 unpaved, in the order the app names them.
    expect(profileFromPoints(points, [0, 1, 0]).surface).toEqual(["paved", "unpaved", "paved"]);
  });

  it("resamples a routed track, and puts it on the ground it was routed over", () => {
    const track: BikeTrack = {
      coordinates: points,
      metres: 2000,
      ascentMetres: 50,
      estimatedSeconds: 600,
      ways: [
        { metres: 1000, tags: { highway: "residential", surface: "asphalt" } },
        { metres: 1000, tags: { highway: "track", surface: "gravel" } },
      ],
    };
    const profile = profileFromTrack(track, 100);
    // Every 100 m over 2 km, plus the exact end.
    expect(profile.km.length).toBeGreaterThan(20);
    expect(profile.km.at(-1)).toBeCloseTo(2, 1);
    expect(profile.surface).toHaveLength(profile.km.length);
    expect(profile.surface[0]).toBe("paved");
    expect(profile.surface.at(-1)).toBe("unpaved");
    // The chart and the timing read the same arrays, so they must be the same
    // length as the positions drawn on the map.
    expect(profile.at).toHaveLength(profile.km.length);
    expect(profile.grade).toHaveLength(profile.km.length);
  });
});
