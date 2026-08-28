import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  budgetOf,
  circleKm,
  homeFromPlan,
  mergeSettings,
  queryFor,
  readRecentHome,
  readSettings,
  rememberHome,
  rememberSettings,
  settingsFromPlan,
  type Settings,
} from "../web/src/settings.js";
import { TOURING_CURVES } from "../src/bike/speed.js";
import { maxRideKm } from "../src/bike/effort.js";
import type { Home } from "../web/src/explore.js";
import type { Plan } from "../src/build/buildPlan.js";

/** localStorage as the browser provides it, in about as many lines as it deserves. */
function stubStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}

beforeEach(stubStorage);

const home: Home = {
  stationId: "SA_ROANNE",
  name: "Roanne",
  at: { lat: 46.0389, lon: 4.0656 },
  rideTo: { lat: 46.034389, lon: 4.079342 },
};

describe("mergeSettings", () => {
  it("keeps the seed when nothing has been stored", () => {
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(DEFAULT_SETTINGS, "not json")).toEqual(DEFAULT_SETTINGS);
  });

  it("takes a stored choice over the seed", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { budgetHours: 6, arriveBy: "10:30" });
    expect(merged.budgetHours).toBe(6);
    expect(merged.arriveBy).toBe("10:30");
  });

  it("fills in a setting that did not exist when the choice was stored", () => {
    // The shape grows; a browser holding last month's object must not come back
    // with holes in it.
    const merged = mergeSettings(DEFAULT_SETTINGS, { budgetHours: 6 });
    expect(merged.maxTransfers).toBe(DEFAULT_SETTINGS.maxTransfers);
    expect(merged.style).toBe(DEFAULT_SETTINGS.style);
  });

  it("ignores a stored value of the wrong shape rather than feeding it to a slider", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      budgetHours: "ten",
      maxDays: Number.NaN,
      dayType: "tuesday",
      radiusKm: -5,
    });
    expect(merged.budgetHours).toBe(DEFAULT_SETTINGS.budgetHours);
    expect(merged.maxDays).toBe(DEFAULT_SETTINGS.maxDays);
    expect(merged.dayType).toBe(DEFAULT_SETTINGS.dayType);
    expect(merged.radiusKm).toBe(DEFAULT_SETTINGS.radiusKm);
  });

  it("keeps an explicit null radius, which means 'as far as the day allows'", () => {
    expect(mergeSettings({ ...DEFAULT_SETTINGS, radiusKm: 80 }, { radiusKm: null }).radiusKm)
      .toBeNull();
  });

  it("survives a round trip through storage", () => {
    const chosen: Settings = { ...DEFAULT_SETTINGS, budgetHours: 7.5, radiusKm: 120 };
    rememberSettings(chosen);
    expect(readSettings(DEFAULT_SETTINGS)).toEqual(chosen);
  });
});

describe("the most recent pair", () => {
  it("comes back exactly as it went in", () => {
    rememberHome(home);
    expect(readRecentHome()).toEqual(home);
  });

  it("is nothing at all until someone picks one", () => {
    expect(readRecentHome()).toBeNull();
  });

  it("refuses a stored pair that is missing a place", () => {
    localStorage.setItem("vojeto.home", JSON.stringify({ stationId: "A" }));
    expect(readRecentHome()).toBeNull();
    localStorage.setItem(
      "vojeto.home",
      JSON.stringify({ stationId: "", at: home.at, rideTo: home.rideTo }),
    );
    expect(readRecentHome()).toBeNull();
  });
});

const plan = {
  settings: {
    arriveBy: "08:30",
    arriveNoEarlierThan: "06:00",
    earliestDeparture: "04:30",
    maxTravelMinutes: 180,
    budgetHours: 8,
    minRideHours: 2,
    maxDays: 2,
    hoursPerDay: 5,
    maxTransfers: 2,
    minTransferMinutes: 8,
    maxTransferMinutes: 40,
    variants: [{ id: "gravel", label: "Gravel", profile: "gravel" }],
  },
  home: { station: { stationId: "SA_ROANNE", name: "Roanne", lat: 46.0389, lon: 4.0656 }, rideTo: home.rideTo },
} as unknown as Plan;

describe("a plan as a starting point", () => {
  it("reads the numbers it was built with", () => {
    const seed = settingsFromPlan(plan);
    expect(seed.arriveBy).toBe("08:30");
    expect(seed.budgetHours).toBe(8);
    expect(seed.minHours).toBe(2);
    expect(seed.maxTravelMinutes).toBe(180);
    expect(seed.style).toBe("gravel");
  });

  it("falls back for anything an older plan did not ship", () => {
    const older = { settings: { arriveBy: "07:45" } } as unknown as Plan;
    const seed = settingsFromPlan(older);
    expect(seed.arriveBy).toBe("07:45");
    expect(seed.maxTravelMinutes).toBe(DEFAULT_SETTINGS.maxTravelMinutes);
    expect(seed.style).toBe(DEFAULT_SETTINGS.style);
  });

  it("uses the defaults when there is no plan at all", () => {
    expect(settingsFromPlan(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("offers the pair it was built for, as a pair like any other", () => {
    expect(homeFromPlan(plan)).toEqual(home);
    expect(homeFromPlan(null)).toBeNull();
  });
});

describe("queryFor", () => {
  it("asks the timetable exactly what the settings say", () => {
    const query = queryFor(home, 20260914, settingsFromPlan(plan));
    expect(query).toEqual({
      date: 20260914,
      origin: "SA_ROANNE",
      earliestDeparture: 4.5 * 3600,
      arriveBy: 8.5 * 3600,
      arriveNoEarlierThan: 6 * 3600,
      maxTravelSeconds: 180 * 60,
      maxTransfers: 2,
      minTransferSeconds: 8 * 60,
      maxTransferSeconds: 40 * 60,
    });
  });
});

describe("the circle", () => {
  const effort = { curves: TOURING_CURVES };

  it("is what you set, when you have set one", () => {
    expect(circleKm({ ...DEFAULT_SETTINGS, radiusKm: 75 }, effort)).toBe(75);
  });

  it("is a guess at your day, when you have not", () => {
    // Ten hours, two of them on the train, eight at a flat 16 km/h, less a
    // third for hills and for roads that do not run straight.
    expect(circleKm({ ...DEFAULT_SETTINGS, budgetHours: 10 }, effort)).toBe(90);
  });

  /**
   * The old default was the theoretical maximum — the whole day at the fastest
   * speed on the curve, no train at all — which came to 184 km for a ten-hour
   * day. True, and useless: a filter that excludes nothing is not a filter.
   */
  it("is well inside what the day could conceivably cover", () => {
    const km = circleKm({ ...DEFAULT_SETTINGS, budgetHours: 10 }, effort);
    expect(km).toBeLessThan(maxRideKm(0, budgetOf(DEFAULT_SETTINGS), effort) / 1.5);
  });

  it("never collapses to nothing on a very short day", () => {
    expect(circleKm({ ...DEFAULT_SETTINGS, budgetHours: 0.5 }, effort)).toBeGreaterThanOrEqual(10);
  });

  it("grows with the day and never shrinks", () => {
    let previous = 0;
    for (const budgetHours of [4, 6, 8, 10, 12]) {
      const km = circleKm({ ...DEFAULT_SETTINGS, budgetHours }, effort);
      expect(km).toBeGreaterThanOrEqual(previous);
      previous = km;
    }
  });
});

describe("budgetOf", () => {
  it("is the day half of the settings, and nothing else", () => {
    expect(budgetOf(DEFAULT_SETTINGS)).toEqual({
      budgetHours: DEFAULT_SETTINGS.budgetHours,
      minHours: DEFAULT_SETTINGS.minHours,
      maxDays: DEFAULT_SETTINGS.maxDays,
      hoursPerDay: DEFAULT_SETTINGS.hoursPerDay,
    });
  });
});
