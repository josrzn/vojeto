import type { ServiceCalendar, ServiceDate } from "../shared/types.js";
import { runsOn } from "./calendar.js";
import { addDays } from "./time.js";

/** How thin a day has to get, relative to a typical day, to count as a stub. */
const STUB_FRACTION = 0.25;

export function countServicesPerDate(
  services: Iterable<ServiceCalendar>,
  start: ServiceDate,
  end: ServiceDate,
): Map<ServiceDate, number> {
  const calendars = [...services];
  const counts = new Map<ServiceDate, number>();
  for (let date = start; date <= end; date = addDays(date, 1)) {
    let active = 0;
    for (const calendar of calendars) if (runsOn(calendar, date)) active++;
    counts.set(date, active);
  }
  return counts;
}

/**
 * The last date the feed still describes a real timetable.
 *
 * Feeds routinely declare a longer window than they actually populate. Rather
 * than trust feed_end_date, this finds where the service count falls off and
 * stays down, so callers never plan into a stub tail.
 */
export function plannableEnd(counts: Map<ServiceDate, number>, fallback: ServiceDate): ServiceDate {
  const dates = [...counts.keys()].sort((a, b) => a - b);
  if (dates.length === 0) return fallback;

  const values = [...counts.values()].sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)] ?? 0;
  if (median === 0) return fallback;

  const threshold = median * STUB_FRACTION;
  for (let i = dates.length - 1; i >= 0; i--) {
    if ((counts.get(dates[i]!) ?? 0) >= threshold) return dates[i]!;
  }
  return fallback;
}
