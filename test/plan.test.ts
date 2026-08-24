import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTimetable } from "../src/gtfs/load.js";
import { sampleDates } from "../src/build/dates.js";
import { normalise, resolveHome, searchStations } from "../src/build/stations.js";
import { addDays, formatDuration, formatTime, parseTime, weekdayIndex } from "../src/gtfs/time.js";
import type { TimetableIndex } from "../src/shared/types.js";

const FEED = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/mini-feed");

let index: TimetableIndex;

beforeAll(async () => {
  index = await loadTimetable({
    zipPath: FEED,
    keepRoutePatterns: [/\bTER\b/],
    dropRoutePatterns: [/TGV/],
  });
});

describe("sampleDates", () => {
  it("returns the second Saturday of each month the feed covers", () => {
    const dates = sampleDates(20260901, 20261231, "saturday", 20260824);
    expect(dates.map((d) => d.date)).toEqual([20260912, 20261010, 20261114, 20261212]);
    expect(dates.map((d) => d.key)).toEqual(["2026-09", "2026-10", "2026-11", "2026-12"]);
    expect(dates[0]!.label).toBe("September 2026");
    for (const { date } of dates) expect(weekdayIndex(date)).toBe(5);
  });

  it("never looks further back than today", () => {
    const dates = sampleDates(20260901, 20261231, "saturday", 20261101);
    expect(dates.every((d) => d.date >= 20261101)).toBe(true);
    expect(dates.map((d) => d.key)).toEqual(["2026-11", "2026-12"]);
  });

  it("falls back to the first match when a month has no second one in range", () => {
    // Starting mid-month leaves 2026-09-26 as the only Saturday left in September.
    const dates = sampleDates(20260901, 20261005, "saturday", 20260921);
    expect(dates.map((d) => d.date)).toEqual([20260926, 20261003]);
  });

  it("picks weekdays and Sundays when asked", () => {
    for (const { date } of sampleDates(20260901, 20261231, "sunday", 20260824)) {
      expect(weekdayIndex(date)).toBe(6);
    }
    for (const { date } of sampleDates(20260901, 20261231, "weekday", 20260824)) {
      expect(weekdayIndex(date)).toBeLessThanOrEqual(4);
    }
  });

  it("returns nothing when the feed has already expired", () => {
    expect(sampleDates(20260101, 20260401, "saturday", 20260824)).toEqual([]);
  });
});

describe("searchStations", () => {
  it("ignores case and accents", () => {
    expect(searchStations(index, "saint-etienne")[0]?.name).toBe("Saint-Etienne Chateaucreux");
    expect(normalise("Saint-Étienne")).toBe("saint-etienne");
  });

  it("puts an exact name match first", () => {
    expect(searchStations(index, "Roanne")[0]?.stationId).toBe("SA_ROANNE");
  });

  it("returns one entry per station, not per platform", () => {
    const matches = searchStations(index, "Roanne");
    expect(matches.filter((m) => m.stationId === "SA_ROANNE")).toHaveLength(1);
  });
});

describe("resolveHome", () => {
  it("resolves a name to its station", () => {
    expect(resolveHome(index, { query: "Roanne", stopId: null }).stationId).toBe("SA_ROANNE");
  });

  it("accepts a platform id and returns its parent station", () => {
    expect(resolveHome(index, { query: "", stopId: "SP_ROANNE_B" }).stationId).toBe("SA_ROANNE");
  });

  it("refuses a name that matches nothing", () => {
    expect(() => resolveHome(index, { query: "Atlantis", stopId: null })).toThrow(/No station/);
  });

  it("refuses an ambiguous name instead of guessing", () => {
    expect(() => resolveHome(index, { query: "Saint", stopId: null })).toThrow(/ambiguous/);
  });

  it("refuses a station id the kept routes do not serve", () => {
    expect(() => resolveHome(index, { query: "", stopId: "SP_PARIS" })).toThrow(/not served/);
  });
});

describe("time formatting", () => {
  it("round-trips a time of day", () => {
    expect(formatTime(parseTime("07:42:00"))).toBe("07:42");
  });

  it("marks a time that runs past midnight", () => {
    expect(formatTime(parseTime("25:10:00"))).toBe("01:10+1");
  });

  it("rejects a malformed time", () => {
    expect(parseTime("")).toBe(-1);
    expect(parseTime("not a time")).toBe(-1);
  });

  it("formats durations the way a timetable would", () => {
    expect(formatDuration(40 * 60)).toBe("40min");
    expect(formatDuration(80 * 60)).toBe("1h20");
    expect(formatDuration(2 * 3600)).toBe("2h00");
  });

  it("adds days across a month boundary", () => {
    expect(addDays(20260930, 1)).toBe(20261001);
    expect(addDays(20261231, 1)).toBe(20270101);
  });
});
