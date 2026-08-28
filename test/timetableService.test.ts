import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTimetable } from "../src/gtfs/load.js";
import { packTimetable } from "../src/gtfs/pack.js";
import { reachableStations, type Query } from "../src/router/raptor.js";
import { TimetableService } from "../web/src/timetableService.js";
import type { Itinerary, TimetableIndex } from "../src/shared/types.js";

const FEED = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/mini-feed");

let index: TimetableIndex;
let files: Map<string, { json?: unknown; bytes?: ArrayBufferLike }>;

/**
 * The two files as the browser would see them, served by a stand-in fetch.
 *
 * Going through the packed bytes rather than handing the service an index
 * directly is the point: it exercises the fetch, the JSON round trip and the
 * unpack, which is everything between `npm run ingest` and a query.
 */
function serve(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const file = files.get(url);
    if (!file) return { ok: false, status: 404 } as Response;
    return {
      ok: true,
      status: 200,
      json: async () => file.json,
      arrayBuffer: async () => file.bytes,
    } as unknown as Response;
  }) as typeof fetch;
}

beforeAll(async () => {
  index = await loadTimetable({
    zipPath: FEED,
    keepRoutePatterns: [/\bTER\b/],
    dropRoutePatterns: [/TGV/],
  });
  const { meta, times } = packTimetable(index);
  files = new Map([
    ["./data/timetable.json", { json: JSON.parse(JSON.stringify(meta)) }],
    [
      "./data/timetable.times.bin",
      { bytes: times.buffer.slice(times.byteOffset, times.byteOffset + times.byteLength) },
    ],
  ]);
});

const query: Query = {
  date: 20260914,
  origin: "SA_ROANNE",
  earliestDeparture: 5 * 3600,
  arriveBy: 9 * 3600,
  arriveNoEarlierThan: 6.5 * 3600,
  maxTravelSeconds: 4 * 3600,
  maxTransfers: 2,
  minTransferSeconds: 300,
  maxTransferSeconds: 3600,
};

describe("TimetableService", () => {
  it("answers exactly what the planner would", async () => {
    const service = new TimetableService();
    await service.load("./data/", serve());
    expect(service.reachable(query)).toEqual(reachableStations(index, query));
  });

  it("reports what it loaded", async () => {
    const service = new TimetableService();
    const loaded = await service.load("./data/", serve());
    expect(loaded.stops).toBe(index.stops.length);
    expect(loaded.patterns).toBe(index.patterns.length);
    expect(loaded.trips).toBe(index.patterns.reduce((n, p) => n + p.trips.length, 0));
    expect(loaded.feedStart).toBe(index.feedStart);
    expect(loaded.plannableEnd).toBe(index.plannableEnd);
  });

  it("lists stations rather than platforms, in name order", async () => {
    const service = new TimetableService();
    const { stations } = await service.load("./data/", serve());

    expect(stations.length).toBe(index.stopsInStation.size);
    expect(stations.length).toBeLessThanOrEqual(index.stops.length);
    expect(new Set(stations.map((s) => s.id)).size).toBe(stations.length);
    expect([...stations].sort((a, b) => a.name.localeCompare(b.name, "fr"))).toEqual(stations);

    // Every station is somewhere: a picker cannot place one without a position.
    for (const station of stations) {
      expect(Number.isFinite(station.lat)).toBe(true);
      expect(Number.isFinite(station.lon)).toBe(true);
    }
    // And the origin the planner uses is in the list, or nothing could be picked.
    expect(stations.map((s) => s.id)).toContain("SA_ROANNE");
  });

  it("says so rather than returning nothing when asked before loading", () => {
    const service = new TimetableService();
    expect(service.ready).toBe(false);
    expect(() => service.reachable(query)).toThrow(/not been loaded/);
  });

  it("is ready once loaded", async () => {
    const service = new TimetableService();
    await service.load("./data/", serve());
    expect(service.ready).toBe(true);
  });

  it("reports a missing file by name and status", async () => {
    const service = new TimetableService();
    await expect(service.load("./elsewhere/", serve())).rejects.toThrow(
      /elsewhere\/timetable\.json returned HTTP 404/,
    );
  });
});

describe("the message protocol", () => {
  it("quotes the id it was asked with, so replies can be told apart", async () => {
    const service = new TimetableService();
    // The service is handed its own fetch inside `handle`, so this drives the
    // real path only as far as the error; the id is the point.
    const reply = await service.handle({ id: 7, kind: "reachable", query });
    expect(reply.id).toBe(7);
    expect(reply.ok).toBe(false);
  });

  it("flattens an error into a message rather than throwing across the boundary", async () => {
    const service = new TimetableService();
    const reply = await service.handle({ id: 1, kind: "reachable", query });
    expect(reply).toEqual({ id: 1, ok: false, error: expect.stringMatching(/not been loaded/) });
  });

  it("carries a successful answer through unchanged", async () => {
    const service = new TimetableService();
    await service.load("./data/", serve());
    const reply = await service.handle({ id: 42, kind: "reachable", query });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value).toEqual(reachableStations(index, query));
  });

  it("returns results that survive being posted between threads", async () => {
    const service = new TimetableService();
    await service.load("./data/", serve());
    const results = service.reachable(query) as Itinerary[];
    expect(results.length).toBeGreaterThan(0);
    // structuredClone is what postMessage does; anything it cannot copy — a
    // Map, a class instance, a function — would fail here rather than in a
    // browser.
    expect(structuredClone(results)).toEqual(results);
  });
});
