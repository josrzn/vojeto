import type { ServiceDate } from "../shared/types.js";
import { addDays, fromServiceDate, toServiceDate, weekdayIndex } from "../gtfs/time.js";

export interface SampleDate {
  /** "2026-09" */
  key: string;
  /** "September 2026" */
  label: string;
  date: ServiceDate;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * One representative date per month covered by the feed.
 *
 * The feed only reaches about five months ahead, so this is what bounds how far
 * out you can plan; it picks the second matching weekday of each month, or the
 * first one still inside the feed's range.
 */
export function sampleDates(
  feedStart: ServiceDate,
  feedEnd: ServiceDate,
  dayType: "saturday" | "sunday" | "weekday",
  today: ServiceDate = toServiceDate(new Date()),
): SampleDate[] {
  const start = Math.max(feedStart, today);
  const matches = (date: ServiceDate): boolean => {
    const day = weekdayIndex(date);
    if (dayType === "saturday") return day === 5;
    if (dayType === "sunday") return day === 6;
    return day <= 4;
  };

  const samples: SampleDate[] = [];
  let cursor = start;
  let currentMonth = -1;
  let seenThisMonth = 0;

  while (cursor <= feedEnd) {
    const month = Math.floor(cursor / 100);
    if (month !== currentMonth) {
      currentMonth = month;
      seenThisMonth = 0;
    }
    if (matches(cursor)) {
      seenThisMonth++;
      const alreadyHave = samples.at(-1)?.key === monthKey(cursor);
      // Prefer the second match of the month; settle for the first if the feed
      // ends, or the month began, before a second one comes round.
      if (!alreadyHave || seenThisMonth === 2) {
        const sample = { key: monthKey(cursor), label: monthLabel(cursor), date: cursor };
        if (alreadyHave) samples[samples.length - 1] = sample;
        else samples.push(sample);
      }
    }
    cursor = addDays(cursor, 1);
  }

  return samples;
}

function monthKey(date: ServiceDate): string {
  return `${Math.floor(date / 10000)}-${String(Math.floor(date / 100) % 100).padStart(2, "0")}`;
}

function monthLabel(date: ServiceDate): string {
  const parsed = fromServiceDate(date);
  return `${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
}
