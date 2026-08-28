import { maxRideKm, type Budget, type EffortModel } from "../../src/bike/effort.js";
import { parseTime } from "../../src/gtfs/time.js";
import type { Query } from "../../src/router/raptor.js";
import type { Plan } from "../../src/build/buildPlan.js";
import type { Home } from "./explore.js";

/**
 * The two kinds of setting, kept apart.
 *
 * What is in here changes rarely and describes you: when you are willing to be
 * off a train, how long a day you want, how fast you ride, how far it is worth
 * looking. What is *not* in here is the pair you change constantly — which
 * station you are leaving from and where the ride has to end — because that is
 * the question you are asking, not the way you like to be answered.
 *
 * Both are remembered, but only this half is a preference.
 */
export interface Settings {
  /** Off the train by, "HH:MM". */
  arriveBy: string;
  /** No earlier than this, so a 5 a.m. arrival is not offered as a day out. */
  arriveNoEarlierThan: string;
  /** The first train worth catching. */
  earliestDeparture: string;
  maxTravelMinutes: number;
  maxTransfers: number;
  minTransferMinutes: number;
  maxTransferMinutes: number;
  /** Which kind of day you are planning for. */
  dayType: DayType;

  /** The whole outing, train and ride together. */
  budgetHours: number;
  /** Below this the ride was not worth the fare. */
  minHours: number;
  maxDays: number;
  hoursPerDay: number;

  /**
   * How far around the door to look, in km, or null for "as far as the day
   * could carry you".
   *
   * A circle is a deliberately crude filter: it is drawn before anything is
   * routed, so it can only be a straight line. Null makes it the furthest the
   * budget could reach with no train at all, which never hides a station that
   * would have worked; a smaller number is you saying you do not want to see
   * that far today.
   */
  radiusKm: number | null;

  /** The way home offered first, by variant id. */
  style: string;
}

export type DayType = "saturday" | "sunday" | "weekday";

export const DEFAULT_SETTINGS: Settings = {
  arriveBy: "09:00",
  arriveNoEarlierThan: "06:30",
  earliestDeparture: "05:00",
  maxTravelMinutes: 240,
  maxTransfers: 1,
  minTransferMinutes: 10,
  maxTransferMinutes: 30,
  dayType: "saturday",
  budgetHours: 10,
  minHours: 3,
  maxDays: 1,
  hoursPerDay: 6,
  radiusKm: null,
  style: "trekking",
};

/**
 * The settings a plan was built with, as a starting point.
 *
 * A plan.json is someone's config already turned into numbers, so it is a
 * better first guess than the defaults for anyone who has run `npm run plan`.
 * Nothing is bound to it: this is a seed, not a ceiling.
 */
export function settingsFromPlan(plan: Plan | null): Settings {
  if (!plan) return DEFAULT_SETTINGS;
  // Read as a partial: a plan.json written before one of these was shipped is
  // still a perfectly good plan, and should fall back rather than crash.
  const s = plan.settings as Partial<Plan["settings"]>;
  return {
    arriveBy: s.arriveBy ?? DEFAULT_SETTINGS.arriveBy,
    arriveNoEarlierThan: s.arriveNoEarlierThan ?? DEFAULT_SETTINGS.arriveNoEarlierThan,
    earliestDeparture: s.earliestDeparture ?? DEFAULT_SETTINGS.earliestDeparture,
    maxTravelMinutes: s.maxTravelMinutes ?? DEFAULT_SETTINGS.maxTravelMinutes,
    maxTransfers: s.maxTransfers ?? DEFAULT_SETTINGS.maxTransfers,
    minTransferMinutes: s.minTransferMinutes ?? DEFAULT_SETTINGS.minTransferMinutes,
    maxTransferMinutes: s.maxTransferMinutes ?? DEFAULT_SETTINGS.maxTransferMinutes,
    dayType: isDayType(s.dayType) ? s.dayType : DEFAULT_SETTINGS.dayType,
    budgetHours: s.budgetHours ?? DEFAULT_SETTINGS.budgetHours,
    minHours: s.minRideHours ?? DEFAULT_SETTINGS.minHours,
    maxDays: s.maxDays ?? DEFAULT_SETTINGS.maxDays,
    hoursPerDay: s.hoursPerDay ?? DEFAULT_SETTINGS.hoursPerDay,
    radiusKm: DEFAULT_SETTINGS.radiusKm,
    style: s.variants?.[0]?.id ?? DEFAULT_SETTINGS.style,
  };
}

/**
 * Stored settings over a seed, key by key.
 *
 * Merged rather than replaced so that a setting added after a browser last
 * stored anything arrives with its default instead of as undefined, and a
 * stored value of the wrong type is ignored rather than fed to a slider.
 */
export function mergeSettings(seed: Settings, stored: unknown): Settings {
  if (!stored || typeof stored !== "object") return seed;
  const raw = stored as Record<string, unknown>;
  const out = { ...seed };
  for (const key of Object.keys(seed) as Array<keyof Settings>) {
    const value = raw[key];
    if (key === "radiusKm") {
      if (value === null || (typeof value === "number" && Number.isFinite(value) && value > 0)) {
        out.radiusKm = value as number | null;
      }
      continue;
    }
    if (key === "dayType") {
      if (isDayType(value)) out.dayType = value;
      continue;
    }
    const expected = typeof seed[key];
    if (typeof value !== expected) continue;
    if (expected === "number" && !Number.isFinite(value as number)) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export const SETTINGS_KEY = "vojeto.settings";
export const HOME_KEY = "vojeto.home";

export function readSettings(seed: Settings): Settings {
  return mergeSettings(seed, readJson(SETTINGS_KEY));
}

export function rememberSettings(settings: Settings): void {
  writeJson(SETTINGS_KEY, settings);
}

/**
 * The last pair of places you asked about.
 *
 * There is no default home in the code, and there should not be: the app is
 * meant to fit whoever opens it, and a hardcoded town is a statement that it
 * was written for someone else. The most recent tuple is the only honest guess,
 * and when there is none the map simply asks.
 */
export function readRecentHome(): Home | null {
  const raw = readJson(HOME_KEY);
  if (!raw || typeof raw !== "object") return null;
  const home = raw as Partial<Home>;
  if (typeof home.stationId !== "string" || home.stationId === "") return null;
  if (!isPoint(home.at) || !isPoint(home.rideTo)) return null;
  return {
    stationId: home.stationId,
    name: typeof home.name === "string" ? home.name : home.stationId,
    at: home.at,
    rideTo: home.rideTo,
  };
}

export function rememberHome(home: Home): void {
  writeJson(HOME_KEY, home);
}

/** Where the plan was built, which is a recent tuple like any other. */
export function homeFromPlan(plan: Plan | null): Home | null {
  if (!plan?.home?.station) return null;
  const station = plan.home.station;
  if (!station.stationId) return null;
  return {
    stationId: station.stationId,
    name: station.name,
    at: { lat: station.lat, lon: station.lon },
    rideTo: plan.home.rideTo,
  };
}

export function budgetOf(settings: Settings): Budget {
  return {
    budgetHours: settings.budgetHours,
    minHours: settings.minHours,
    maxDays: settings.maxDays,
    hoursPerDay: settings.hoursPerDay,
  };
}

/**
 * The query the timetable is asked, from the settings on screen.
 *
 * One place, so that picking a station by hand asks exactly what `npm run plan`
 * asks. The alternative is two call sites that agree until someone changes a
 * default in one of them.
 */
export function queryFor(home: Home, date: number, settings: Settings): Query {
  return {
    date,
    origin: home.stationId,
    earliestDeparture: parseTime(settings.earliestDeparture),
    arriveBy: parseTime(settings.arriveBy),
    arriveNoEarlierThan: parseTime(settings.arriveNoEarlierThan),
    maxTravelSeconds: settings.maxTravelMinutes * 60,
    maxTransfers: settings.maxTransfers,
    minTransferSeconds: settings.minTransferMinutes * 60,
    maxTransferSeconds: settings.maxTransferMinutes * 60,
  };
}

/** The radius of the ring on the map: what you set, or what the day allows. */
export function circleKm(settings: Settings, effort: EffortModel): number {
  return settings.radiusKm ?? Math.round(maxRideKm(0, budgetOf(settings), effort));
}

function readJson(key: string): unknown {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : null;
  } catch {
    // A private window, storage disabled, or something that is not JSON.
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The choice holds for this session and no longer.
  }
}

function isDayType(value: unknown): value is DayType {
  return value === "saturday" || value === "sunday" || value === "weekday";
}

function isPoint(value: unknown): value is { lat: number; lon: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as { lat?: unknown; lon?: unknown };
  return Number.isFinite(point.lat) && Number.isFinite(point.lon);
}
