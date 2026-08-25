import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keepStop, stopKind, summariseKinds } from "../src/gtfs/serviceKind.js";
import { countServicesPerDate, plannableEnd } from "../src/gtfs/coverage.js";
import { loadTimetable } from "../src/gtfs/load.js";
import { reachableStations } from "../src/router/raptor.js";
import { emptyCalendar } from "../src/gtfs/calendar.js";
import type { ServiceCalendar, TimetableIndex } from "../src/shared/types.js";

const FEED = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sncf-feed");

describe("stopKind", () => {
  it("reads the service type out of a stop point id", () => {
    expect(stopKind("StopPoint:OCETrain TER-87726802")).toBe("OCETrain TER");
    expect(stopKind("StopPoint:OCECar TER-87726802")).toBe("OCECar TER");
    expect(stopKind("StopPoint:OCEINTERCITES-87726802")).toBe("OCEINTERCITES");
    expect(stopKind("StopPoint:OCETGV INOUI-87686006")).toBe("OCETGV INOUI");
  });

  it("keeps the last hyphen as the separator, so hyphenated kinds survive", () => {
    expect(stopKind("StopPoint:OCEINTERCITES de nuit-87686006")).toBe("OCEINTERCITES de nuit");
  });

  it("returns null for stations and for ids not using the convention", () => {
    expect(stopKind("StopArea:OCE87726802")).toBeNull();
    expect(stopKind("SP_ROANNE")).toBeNull();
    expect(stopKind("StopPoint:")).toBeNull();
  });
});

describe("keepStop", () => {
  const keep = new Set(["OCETrain TER"]);

  it("keeps the wanted kind and rejects the others", () => {
    expect(keepStop("StopPoint:OCETrain TER-87726802", keep)).toBe(true);
    expect(keepStop("StopPoint:OCECar TER-87726802", keep)).toBe(false);
    expect(keepStop("StopPoint:OCETGV INOUI-87726802", keep)).toBe(false);
  });

  it("keeps everything when no kinds are configured", () => {
    expect(keepStop("StopPoint:OCETGV INOUI-87726802", new Set())).toBe(true);
  });

  it("keeps ids that carry no kind, since they cannot be judged", () => {
    expect(keepStop("SP_ROANNE", keep)).toBe(true);
  });
});

describe("summariseKinds", () => {
  it("counts kinds and labels stations separately", () => {
    const counts = summariseKinds([
      "StopArea:OCE1",
      "StopPoint:OCETrain TER-1",
      "StopPoint:OCETrain TER-2",
      "StopPoint:OCECar TER-1",
      "weird",
    ]);
    expect(counts.get("OCETrain TER")).toBe(2);
    expect(counts.get("OCECar TER")).toBe(1);
    expect(counts.get("(station)")).toBe(1);
    expect(counts.get("(no kind)")).toBe(1);
  });
});

describe("plannableEnd", () => {
  const calendar = (dates: number[]): ServiceCalendar => {
    const c = emptyCalendar();
    for (const d of dates) c.added.add(d);
    return c;
  };

  it("stops at the point a feed's tail thins out to stubs", () => {
    // 20 services through 2026-09-05, then a single stub service running on.
    const services = [
      ...Array.from({ length: 20 }, () =>
        calendar([20260901, 20260902, 20260903, 20260904, 20260905]),
      ),
      calendar([20260906, 20260907, 20260908, 20260909, 20260910]),
    ];
    const counts = countServicesPerDate(services, 20260901, 20260910);
    expect(counts.get(20260903)).toBe(20);
    expect(counts.get(20260908)).toBe(1);
    expect(plannableEnd(counts, 20260910)).toBe(20260905);
  });

  it("returns the real end when the feed stays dense throughout", () => {
    const services = Array.from({ length: 10 }, () =>
      calendar([20260901, 20260902, 20260903]),
    );
    const counts = countServicesPerDate(services, 20260901, 20260903);
    expect(plannableEnd(counts, 20260903)).toBe(20260903);
  });

  it("falls back when there is nothing to measure", () => {
    expect(plannableEnd(new Map(), 20260903)).toBe(20260903);
    const empty = countServicesPerDate([], 20260901, 20260903);
    expect(plannableEnd(empty, 20260903)).toBe(20260903);
  });
});

describe("loading a feed that uses SNCF id conventions", () => {
  let index: TimetableIndex;

  beforeAll(async () => {
    index = await loadTimetable({
      zipPath: FEED,
      keepRoutePatterns: [],
      dropRoutePatterns: [],
      keepStopKinds: ["OCETrain TER"],
    });
  });

  it("keeps only TER train stops, dropping coach, Intercités and TGV", () => {
    const kinds = new Set(index.stops.map((s) => stopKind(s.id)));
    expect([...kinds]).toEqual(["OCETrain TER"]);
  });

  it("resolves the station a kept stop belongs to", () => {
    expect(index.stopsInStation.get("StopArea:OCE87726802")).toHaveLength(1);
  });

  it("finds the TER destinations and nothing else", () => {
    const results = reachableStations(index, {
      date: 20260902,
      origin: "StopArea:OCE87726802",
      earliestDeparture: 5 * 3600,
      arriveBy: 9 * 3600,
      arriveNoEarlierThan: 6 * 3600,
      maxTravelSeconds: 4 * 3600,
      maxTransfers: 2,
      minTransferSeconds: 300,
      maxTransferSeconds: 3600,
    });
    expect(results.map((r) => r.destinationName).sort()).toEqual([
      "Lyon Part Dieu",
      "Saint-Étienne Châteaucreux",
    ]);
  });

  it("brings back TGV and Intercités when the kind filter is lifted", async () => {
    const everything = await loadTimetable({
      zipPath: FEED,
      keepRoutePatterns: [],
      dropRoutePatterns: [],
      keepStopKinds: [],
    });
    const results = reachableStations(everything, {
      date: 20260902,
      origin: "StopArea:OCE87726802",
      earliestDeparture: 5 * 3600,
      arriveBy: 9 * 3600,
      arriveNoEarlierThan: 6 * 3600,
      maxTravelSeconds: 4 * 3600,
      maxTransfers: 2,
      minTransferSeconds: 300,
      maxTransferSeconds: 3600,
    });
    // Amplepuis stays out even here: its route is route_type 3, a coach, which
    // the rail check rejects independently of the stop kind filter.
    expect(results.map((r) => r.destinationName).sort()).toEqual([
      "Lyon Part Dieu",
      "Nantes",
      "Paris Gare de Lyon",
      "Saint-Étienne Châteaucreux",
    ]);
  });

  it("excludes replacement coaches by route_type as well as by stop kind", async () => {
    const everything = await loadTimetable({
      zipPath: FEED,
      keepRoutePatterns: [],
      dropRoutePatterns: [],
      keepStopKinds: [],
      keepRouteTypes: [2, 3],
    });
    const results = reachableStations(everything, {
      date: 20260902,
      origin: "StopArea:OCE87726802",
      earliestDeparture: 5 * 3600,
      arriveBy: 9 * 3600,
      arriveNoEarlierThan: 6 * 3600,
      maxTravelSeconds: 4 * 3600,
      maxTransfers: 2,
      minTransferSeconds: 300,
      maxTransferSeconds: 3600,
    });
    // Only once route_type 3 is explicitly allowed does the coach appear.
    expect(results.map((r) => r.destinationName)).toContain("Amplepuis");
  });
});
