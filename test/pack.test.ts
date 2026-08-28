import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTimetable } from "../src/gtfs/load.js";
import { packTimetable, unpackTimetable, type PackedTimetable } from "../src/gtfs/pack.js";
import { reachableStations, type Query } from "../src/router/raptor.js";
import type { TimetableIndex } from "../src/shared/types.js";

const FEED = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/mini-feed");

let index: TimetableIndex;
let restored: TimetableIndex;

beforeAll(async () => {
  index = await loadTimetable({
    zipPath: FEED,
    keepRoutePatterns: [/\bTER\b/],
    dropRoutePatterns: [/TGV/],
  });
  // Through JSON on the way, because that is what the browser will do to it —
  // a value that survives a structured clone but not JSON.stringify would pass
  // a naive round trip and fail in the only place that matters.
  const { meta, times } = packTimetable(index);
  const asShipped = JSON.parse(JSON.stringify(meta)) as PackedTimetable;
  const bytes = new Uint8Array(times.buffer.slice(0)).slice();
  restored = unpackTimetable(asShipped, new Int32Array(bytes.buffer));
});

describe("packing the timetable", () => {
  it("comes back as the index that went in", () => {
    // The whole thing, not a sample of it: stops, patterns, every trip's times,
    // the calendars, the derived lookups and the date coverage.
    expect(restored).toEqual(index);
  });

  it("answers a query identically", () => {
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
    const before = reachableStations(index, query);
    expect(before.length).toBeGreaterThan(0);
    expect(reachableStations(restored, query)).toEqual(before);
  });

  it("stores each string exactly once, however often it is used", () => {
    const { meta } = packTimetable(index);

    // Every string the index mentions anywhere, with its repetitions.
    const used = [
      ...index.stops.flatMap((s) => [s.id, s.name, s.station]),
      ...index.patterns.flatMap((p) =>
        p.trips.flatMap((t) => [t.tripId, t.serviceId, t.headsign, t.routeName]),
      ),
      ...index.services.keys(),
    ];
    const distinct = new Set(used);

    // The table is exactly the distinct set: no duplicates, nothing missing,
    // nothing spare. Route names and headsigns repeat across trips, so on any
    // real feed this is far smaller than `used`.
    expect(meta.strings).toHaveLength(distinct.size);
    expect(new Set(meta.strings)).toEqual(distinct);
    expect(distinct.size).toBeLessThanOrEqual(used.length);
  });

  it("gives every trip a times view of the right length", () => {
    for (const pattern of restored.patterns) {
      for (const trip of pattern.trips) {
        expect(trip.times.length).toBe(pattern.stops.length * 2);
      }
    }
  });

  it("shares one buffer across every trip rather than copying", () => {
    const buffers = new Set(
      restored.patterns.flatMap((p) => p.trips.map((t) => t.times.buffer)),
    );
    expect(buffers.size).toBe(1);
  });

  it("refuses an index written by a version it does not understand", () => {
    const { meta, times } = packTimetable(index);
    expect(() => unpackTimetable({ ...meta, version: 2 as 1 }, times)).toThrow(/version 2/);
  });

  it("says which string is missing rather than yielding undefined", () => {
    const { meta, times } = packTimetable(index);
    expect(() => unpackTimetable({ ...meta, strings: [] }, times)).toThrow(/string 0/);
  });
});

describe("the shape of the packed file", () => {
  it("carries no derived lookups, since they are rebuilt", () => {
    const { meta } = packTimetable(index);
    const keys = Object.keys(meta);
    expect(keys).not.toContain("stopIndex");
    expect(keys).not.toContain("stopsInStation");
    expect(keys).not.toContain("patternsAtStop");
  });

  it("marks the end of every span, so no span needs a special case", () => {
    const { meta, times } = packTimetable(index);
    expect(meta.patterns.stopStart.at(-1)).toBe(meta.patterns.stops.length);
    expect(meta.patterns.tripStart.at(-1)).toBe(meta.trips.tripId.length);
    expect(meta.trips.timeStart.at(-1)).toBe(times.length);
    expect(meta.patterns.stopStart).toHaveLength(index.patterns.length + 1);
  });

  it("keeps positions exact rather than rounding them to a grid", () => {
    // A stop decoded a metre from where it was parsed would move every ride's
    // start, and the error would be invisible.
    for (let i = 0; i < index.stops.length; i++) {
      expect(restored.stops[i]!.lat).toBe(index.stops[i]!.lat);
      expect(restored.stops[i]!.lon).toBe(index.stops[i]!.lon);
    }
  });
});
