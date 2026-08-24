import type { ServiceCalendar, ServiceDate } from "../shared/types.js";
import { weekdayIndex } from "./time.js";

/** GTFS rule: calendar_dates exceptions override the weekly pattern in calendar.txt. */
export function runsOn(calendar: ServiceCalendar, date: ServiceDate): boolean {
  if (calendar.removed.has(date)) return false;
  if (calendar.added.has(date)) return true;
  if (date < calendar.start || date > calendar.end) return false;
  return (calendar.weekdayMask >> weekdayIndex(date) & 1) === 1;
}

export function emptyCalendar(): ServiceCalendar {
  return { weekdayMask: 0, start: 99999999, end: 0, added: new Set(), removed: new Set() };
}
