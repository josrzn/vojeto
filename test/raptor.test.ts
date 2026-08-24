import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTimetable } from "../src/gtfs/load.js";
import { reachableStations, type Query } from "../src/router/raptor.js";
import { formatTime } from "../src/gtfs/time.js";
import type { Itinerary, TimetableIndex } from "../src/shared/types.js";

const FEED = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/mini-feed");

let index: TimetableIndex;

beforeAll(async () => {
  index = await loadTimetable({
    zipPath: FEED,
    keepRoutePatterns: [/\bTER\b/],
    dropRoutePatterns: [/TGV/],
  });
});

function query(date: number, overrides: Partial<Query> = {}): Itinerary[] {
  return reachableStations(index, {
    date,
    origin: "SA_ROANNE",
    earliestDeparture: 5 * 3600,
    arriveBy: 9 * 3600,
    arriveNoEarlierThan: 6.5 * 3600,
    maxTravelSeconds: 4 * 3600,
    maxTransfers: 2,
    minTransferSeconds: 300,
    ...overrides,
  });
}

const summarise = (results: Itinerary[]) =>
  Object.fromEntries(
    results.map((r) => [
      r.destinationName,
      `${formatTime(r.departure)}-${formatTime(r.arrival)}/${r.transfers}`,
    ]),
  );

describe("loadTimetable", () => {
  it("keeps only routes matching the filter", () => {
    const names = new Set(index.patterns.flatMap((p) => p.trips.map((t) => t.routeName)));
    expect([...names].some((n) => n.includes("TGV"))).toBe(false);
    expect(index.stopIndex.has("SP_PARIS")).toBe(false);
  });

  it("groups trips with the same stop sequence into one pattern", () => {
    const lyon = index.patterns.find((p) => p.trips.some((t) => t.tripId === "LYON_0600"));
    expect(lyon?.trips.map((t) => t.tripId)).toEqual(["LYON_0600", "LYON_0720"]);
  });

  it("reports the feed's date coverage", () => {
    expect(index.feedStart).toBe(20260901);
    expect(index.feedEnd).toBe(20261231);
  });
});

describe("reachableStations", () => {
  it("finds every station reachable in time on a weekday", () => {
    expect(summarise(query(20260914))).toEqual({
      Tarare: "07:20-08:00/0",
      "Saint-Germain-des-Fosses": "06:30-07:10/0",
      "Saint-Etienne Chateaucreux": "07:45-08:50/0",
      "Lyon Part-Dieu": "07:20-08:40/0",
      "Clermont-Ferrand": "06:30-08:20/1",
    });
  });

  it("prefers the later departure when two journeys take the same time", () => {
    // Lyon is served at 06:00-07:20 and 07:20-08:40; both take 1h20.
    const lyon = query(20260914).find((r) => r.destinationName === "Lyon Part-Dieu");
    expect(lyon?.departure).toBe(7 * 3600 + 20 * 60);
  });

  it("rejects an arrival that is too early to be useful", () => {
    // Saint-Etienne's 05:10 train lands at 06:10, before arriveNoEarlierThan.
    const early = query(20260914, { arriveNoEarlierThan: 0 });
    expect(summarise(early)["Saint-Etienne Chateaucreux"]).toBe("05:10-06:10/0");
  });

  it("rejects an arrival after the deadline", () => {
    expect(summarise(query(20260914))).not.toHaveProperty("Latecity");
    const later = query(20260914, { arriveBy: 10 * 3600 });
    expect(summarise(later)["Latecity"]).toBe("08:30-09:30/0");
  });

  it("honours the interchange buffer when changing platforms", () => {
    // Arrival at Saint-Germain is 07:10; the 07:12 to Clermont is not catchable
    // with a 5 minute buffer, so the itinerary uses the 07:30.
    const clermont = query(20260914).find((r) => r.destinationName === "Clermont-Ferrand");
    expect(clermont?.legs.map((l) => l.tripId)).toEqual(["VICHY_0630", "CLERM_0730"]);
    expect(clermont?.arrival).toBe(8 * 3600 + 20 * 60);

    const relaxed = query(20260914, { minTransferSeconds: 60 });
    const faster = relaxed.find((r) => r.destinationName === "Clermont-Ferrand");
    expect(faster?.legs.map((l) => l.tripId)).toEqual(["VICHY_0630", "CLERM_0712"]);
    expect(faster?.arrival).toBe(8 * 3600 + 2 * 60);
  });

  it("drops journeys that need more transfers than allowed", () => {
    expect(summarise(query(20260914, { maxTransfers: 0 }))).not.toHaveProperty("Clermont-Ferrand");
  });

  it("applies calendar.txt weekday rules", () => {
    expect(summarise(query(20260920))).toHaveProperty("Sundayville");
    expect(summarise(query(20260914))).not.toHaveProperty("Sundayville");
  });

  it("applies calendar_dates.txt removals", () => {
    // The whole DAILY service is cancelled on 2026-09-25, a Friday.
    expect(query(20260925)).toEqual([]);
  });

  it("returns itineraries ordered by journey time", () => {
    const durations = query(20260914).map((r) => r.duration);
    expect(durations).toEqual([...durations].sort((a, b) => a - b));
  });

  it("builds legs that chain end to end", () => {
    for (const itinerary of query(20260914)) {
      for (let i = 1; i < itinerary.legs.length; i++) {
        expect(itinerary.legs[i]!.departure).toBeGreaterThanOrEqual(itinerary.legs[i - 1]!.arrival);
      }
      expect(itinerary.legs.at(-1)!.arrival).toBe(itinerary.arrival);
      expect(itinerary.legs[0]!.departure).toBe(itinerary.departure);
    }
  });
});
