import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { planRideHome, simplify, type RideOptions } from "../src/bike/returnRoute.js";
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
  profile: "trekking",
  cacheDir,
  throttleMs: 0,
  kmPerDay: 90,
  maxTotalKm: 400,
  ...overrides,
});

const STATIONS = [
  { stationId: "SA_TARARE", name: "Tarare", lat: 45.8964, lon: 4.4336 },
  { stationId: "SA_LYON", name: "Lyon Part-Dieu", lat: 45.7605, lon: 4.86 },
  { stationId: "SA_FAR", name: "Far Away", lat: 44.0, lon: 2.0 },
];

describe("routeBike", () => {
  it("reads distance, ascent and time out of the BRouter response", async () => {
    const track = await routeBike([LYON, ROANNE], options());
    expect(track.ascentMetres).toBe(612);
    expect(track.estimatedSeconds).toBe(18000);
    expect(track.metres).toBeGreaterThan(60_000);
    expect(track.coordinates.length).toBe(400);
  });

  it("serves a repeated request from the disk cache", async () => {
    const before = requests;
    await routeBike([LYON, ROANNE], options());
    await routeBike([LYON, ROANNE], options());
    expect(requests).toBe(before);
  });

  it("reports BRouter's plain-text errors instead of failing to parse", async () => {
    respondWith = "operation not supported: no route found";
    await expect(
      routeBike([{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }], options()),
    ).rejects.toThrow(/no route found/);
    respondWith = null;
  });

  it("refuses a single waypoint", async () => {
    await expect(routeBike([LYON], options())).rejects.toThrow(/at least two/);
  });
});

describe("planRideHome", () => {
  it("splits the ride into whole days that add up to the total", async () => {
    const ride = await planRideHome(LYON, ROANNE, STATIONS, options({ kmPerDay: 30 }));
    expect(ride.days).toBe(Math.ceil(ride.km / 30));
    expect(ride.stages).toHaveLength(ride.days);
    const summed = ride.stages.reduce((total, stage) => total + stage.km, 0);
    expect(summed).toBeCloseTo(ride.km, 6);
  });

  it("keeps a short ride as a single day with no overnight stop", async () => {
    const ride = await planRideHome(LYON, ROANNE, STATIONS, options({ kmPerDay: 200 }));
    expect(ride.days).toBe(1);
    expect(ride.stages[0]!.bailout).toBeNull();
  });

  it("shares the reported ascent out across the stages", async () => {
    const ride = await planRideHome(LYON, ROANNE, STATIONS, options({ kmPerDay: 30 }));
    const summed = ride.stages.reduce((total, stage) => total + stage.ascentMetres, 0);
    expect(summed).toBeGreaterThan(ride.ascentMetres - ride.stages.length);
    expect(summed).toBeLessThan(ride.ascentMetres + ride.stages.length);
  });

  it("tags each overnight stop with a station to bail out from", async () => {
    const ride = await planRideHome(LYON, ROANNE, STATIONS, options({ kmPerDay: 30 }));
    const bailouts = ride.stages.slice(0, -1).map((stage) => stage.bailout);
    expect(bailouts.every((b) => b !== null)).toBe(true);
    expect(bailouts.some((b) => b?.name === "Tarare")).toBe(true);
    for (const bailout of bailouts) expect(bailout!.detourKm).toBeLessThanOrEqual(15);
  });

  it("leaves the overnight stop untagged when no station is near", async () => {
    const ride = await planRideHome(
      LYON,
      ROANNE,
      STATIONS,
      options({ kmPerDay: 30, maxBailoutKm: 0.5 }),
    );
    expect(ride.stages.slice(0, -1).every((stage) => stage.bailout === null)).toBe(true);
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
