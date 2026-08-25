import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { planRidesHome, simplify, type RideOptions } from "../src/bike/returnRoute.js";
import { routeBike } from "../src/bike/brouter.js";
import { cumulativeDistances, haversine } from "../src/shared/geo.js";

const LYON = { lat: 45.7605, lon: 4.86 };
const ROANNE = { lat: 46.0389, lon: 4.0656 };

/** A straight-ish line from Lyon to Roanne with a hill in the middle. */
function fakeTrack(points = 400): { geojson: string; coordinates: number[][] } {
  const coordinates: number[][] = [];
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    const altitude = 200 + Math.round(600 * Math.sin(Math.PI * t));
    coordinates.push([
      LYON.lon + (ROANNE.lon - LYON.lon) * t,
      LYON.lat + (ROANNE.lat - LYON.lat) * t,
      altitude,
    ]);
  }
  const geojson = JSON.stringify({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          "track-length": String(Math.round(cumulativeDistances(coordinates).at(-1)!)),
          "filtered ascend": "612",
          "total-time": "18000",
        },
        geometry: { type: "LineString", coordinates },
      },
    ],
  });
  return { geojson, coordinates };
}

let server: Server;
let baseUrl: string;
let cacheDir: string;
let requests = 0;
let respondWith: string | null = null;

beforeAll(async () => {
  const { geojson } = fakeTrack();
  server = createServer((req, res) => {
    requests++;
    if (respondWith !== null) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(respondWith);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(geojson);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/brouter`;
  cacheDir = await mkdtemp(path.join(tmpdir(), "vojeto-cache-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(cacheDir, { recursive: true, force: true });
});

const options = (overrides: Partial<RideOptions> = {}): RideOptions => ({
  baseUrl,
  cacheDir,
  throttleMs: 0,
  variants: [{ id: "trekking", label: "Quiet roads", profile: "trekking" }],
  alternatives: 1,
  effort: { speedKmh: 16, climbMetresPerHour: 600 },
  budget: { budgetHours: 12, maxDays: 1, hoursPerDay: 6, minHours: 0 },
  trainHours: 1,
  ...overrides,
});

const brouter = (overrides: Partial<RideOptions> = {}) => ({
  baseUrl,
  cacheDir,
  throttleMs: 0,
  profile: "trekking",
  ...overrides,
});

// Spread roughly along the Lyon -> Roanne line, plus one far away that should
// never be picked.
const STATIONS = [
  { stationId: "SA_LYON", name: "Lyon Part-Dieu", lat: 45.7605, lon: 4.86 },
  { stationId: "SA_TARARE", name: "Tarare", lat: 45.8964, lon: 4.4336 },
  { stationId: "SA_LOZANNE", name: "Lozanne", lat: 45.8567, lon: 4.6844 },
  { stationId: "SA_AMPLEPUIS", name: "Amplepuis", lat: 45.96, lon: 4.331 },
  { stationId: "SA_REGNY", name: "Régny", lat: 46.0169, lon: 4.1889 },
  { stationId: "SA_FAR", name: "Far Away", lat: 44.0, lon: 2.0 },
];

describe("routeBike", () => {
  it("reads distance, ascent and time out of the BRouter response", async () => {
    const track = await routeBike([LYON, ROANNE], brouter());
    expect(track.ascentMetres).toBe(612);
    expect(track.estimatedSeconds).toBe(18000);
    expect(track.metres).toBeGreaterThan(60_000);
    expect(track.coordinates.length).toBe(400);
  });

  it("serves a repeated request from the disk cache", async () => {
    const before = requests;
    await routeBike([LYON, ROANNE], brouter());
    await routeBike([LYON, ROANNE], brouter());
    expect(requests).toBe(before);
  });

  it("reports BRouter's plain-text errors instead of failing to parse", async () => {
    respondWith = "operation not supported: no route found";
    await expect(
      routeBike([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }], brouter()),
    ).rejects.toThrow(/no route found/);
    respondWith = null;
  });

  it("refuses a single waypoint", async () => {
    await expect(routeBike([LYON], brouter())).rejects.toThrow(/at least two/);
  });
});

describe("planRidesHome", () => {
  const ride = async (overrides: Partial<RideOptions> = {}) =>
    planRidesHome(LYON, ROANNE, STATIONS, options(overrides));

  it("returns one variant per profile and alternative", async () => {
    const result = await ride({
      variants: [
        { id: "trekking", label: "Quiet roads", profile: "trekking" },
        { id: "fast", label: "Direct", profile: "fastbike" },
      ],
      alternatives: 1,
    });
    expect(result.variants.map((v) => v.id)).toEqual(["trekking", "fast"]);
    expect(result.failures).toEqual([]);
  });

  it("drops an alternative that retraces the same road", async () => {
    // The stub returns an identical track whatever alternativeidx is asked for.
    const result = await ride({ alternatives: 3 });
    expect(result.variants).toHaveLength(1);
  });

  it("reports a profile the server rejects without losing the others", async () => {
    // A fresh cache dir and an unused profile name, so the request really goes
    // to the server rather than being answered from an earlier test's cache.
    const isolated = await mkdtemp(path.join(tmpdir(), "vojeto-fail-"));
    respondWith = "profile not found";
    const result = await ride({
      cacheDir: isolated,
      variants: [{ id: "nope", label: "Missing", profile: "no-such-profile" }],
    });
    respondWith = null;
    await rm(isolated, { recursive: true, force: true });
    expect(result.variants).toEqual([]);
    expect(result.failures[0]?.reason).toMatch(/profile not found/);
  });

  it("estimates hours from distance and climb, not from BRouter", async () => {
    const [variant] = (await ride()).variants;
    // 612 m of ascent at 600 m/h is just over an hour on top of the flat time.
    expect(variant!.hours).toBeCloseTo(variant!.km / 16 + 612 / 600, 5);
    expect(variant!.brouterHours).toBeCloseTo(5, 5);
  });

  it("marks a ride that fits the remaining budget", async () => {
    const [variant] = (await ride({ budget: { budgetHours: 12, maxDays: 1, hoursPerDay: 6, minHours: 0 } })).variants;
    expect(variant!.feasible).toBe(true);
    expect(variant!.days).toBe(1);
    expect(variant!.slackHours).toBeGreaterThan(0);
  });

  it("marks a ride that overruns a single day", async () => {
    const [variant] = (await ride({ budget: { budgetHours: 4, maxDays: 1, hoursPerDay: 6, minHours: 0 } })).variants;
    expect(variant!.feasible).toBe(false);
    expect(variant!.slackHours).toBeLessThan(0);
  });

  it("splits a long ride into days whose hours add up to the total", async () => {
    const [variant] = (await ride({
      budget: { budgetHours: 3, maxDays: 4, hoursPerDay: 1.5, minHours: 0 },
    })).variants;
    expect(variant!.days).toBeGreaterThan(1);
    expect(variant!.stages).toHaveLength(variant!.days);
    const summedHours = variant!.stages.reduce((total, s) => total + s.hours, 0);
    expect(summedHours).toBeCloseTo(variant!.hours, 5);
    const summedKm = variant!.stages.reduce((total, s) => total + s.km, 0);
    expect(summedKm).toBeCloseTo(variant!.km, 5);
  });

  it("tags overnight stops with a nearby station to bail out from", async () => {
    const [variant] = (await ride({
      budget: { budgetHours: 3, maxDays: 4, hoursPerDay: 1.5, minHours: 0 },
    })).variants;
    // The final stage ends at home, so it never carries a bail-out.
    expect(variant!.stages.at(-1)!.bailout).toBeNull();

    const overnight = variant!.stages.slice(0, -1);
    expect(overnight.length).toBeGreaterThan(0);
    expect(overnight.some((s) => s.bailout !== null)).toBe(true);
    for (const stage of overnight) {
      if (stage.bailout) expect(stage.bailout.detourKm).toBeLessThanOrEqual(15);
    }
    expect(overnight.map((s) => s.bailout?.name)).not.toContain("Far Away");
  });

  it("leaves the overnight stop untagged when no station is near", async () => {
    const [variant] = (await ride({
      budget: { budgetHours: 3, maxDays: 4, hoursPerDay: 1.5, minHours: 0 },
      maxBailoutKm: 0.5,
    })).variants;
    expect(variant!.stages.slice(0, -1).every((s) => s.bailout === null)).toBe(true);
  });

  it("shares the reported ascent out across the stages", async () => {
    const [variant] = (await ride({
      budget: { budgetHours: 3, maxDays: 4, hoursPerDay: 1.5, minHours: 0 },
    })).variants;
    const summed = variant!.stages.reduce((total, s) => total + s.ascentMetres, 0);
    expect(summed).toBeGreaterThan(variant!.ascentMetres - variant!.stages.length);
    expect(summed).toBeLessThan(variant!.ascentMetres + variant!.stages.length);
  });
});

describe("simplify", () => {
  it("drops vertices while staying close to the original line", () => {
    const { coordinates } = fakeTrack(400);
    const simplified = simplify(coordinates, 150);
    expect(simplified.length).toBeLessThan(coordinates.length);
    expect(simplified[0]).toEqual([coordinates[0]![0], coordinates[0]![1]]);
    expect(simplified.at(-1)).toEqual([coordinates.at(-1)![0], coordinates.at(-1)![1]]);
    for (const [lon, lat] of simplified) expect(Number.isFinite(lon) && Number.isFinite(lat)).toBe(true);
  });

  it("keeps a sharp corner that a coarse tolerance would otherwise cut", () => {
    const corner = [
      [4.0, 46.0],
      [4.5, 46.0],
      [4.5, 46.5],
    ];
    expect(simplify(corner, 150)).toHaveLength(3);
  });

  it("passes through lines of two points or fewer", () => {
    expect(simplify([[1, 2, 3]], 150)).toEqual([[1, 2]]);
    expect(simplify([[1, 2, 3], [4, 5, 6]], 150)).toEqual([[1, 2], [4, 5]]);
  });
});

describe("haversine", () => {
  it("matches a known distance", () => {
    // Lyon Part-Dieu to Roanne is a little under 69 km as the crow flies.
    expect(haversine(LYON, ROANNE) / 1000).toBeCloseTo(68.8, 1);
  });

  it("is zero for a point against itself", () => {
    expect(haversine(LYON, LYON)).toBe(0);
  });
});
