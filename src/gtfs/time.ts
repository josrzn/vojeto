import type { ServiceDate, ServiceTime } from "../shared/types.js";

/** "07:42:00" -> 27720. Accepts hours >= 24 (GTFS trips running past midnight). */
export function parseTime(value: string): ServiceTime {
  const text = value.trim();
  if (text === "") return -1;
  let h = 0;
  let m = 0;
  let s = 0;
  let part = 0;
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 58 /* : */) {
      if (part === 0) h = acc;
      else if (part === 1) m = acc;
      part++;
      acc = 0;
    } else if (c >= 48 && c <= 57) {
      acc = acc * 10 + (c - 48);
    } else {
      return -1;
    }
  }
  if (part === 0) return -1;
  if (part === 1) m = acc;
  else s = acc;
  return h * 3600 + m * 60 + s;
}

/** 27720 -> "07:42". Hours past midnight wrap for display: 25:10 shows as "01:10+1". */
export function formatTime(seconds: ServiceTime): string {
  if (seconds < 0) return "--:--";
  const dayOffset = Math.floor(seconds / 86400);
  const within = seconds - dayOffset * 86400;
  const h = String(Math.floor(within / 3600)).padStart(2, "0");
  const m = String(Math.floor((within % 3600) / 60)).padStart(2, "0");
  return dayOffset > 0 ? `${h}:${m}+${dayOffset}` : `${h}:${m}`;
}

/** "1h47" for 6420 seconds. */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

/** "09:00" or "09:00:00" -> seconds. Throws on anything else, since these come from config. */
export function requireTime(value: string, field: string): ServiceTime {
  const parsed = parseTime(value);
  if (parsed < 0) throw new Error(`${field}: expected HH:MM, got ${JSON.stringify(value)}`);
  return parsed;
}

export function toServiceDate(date: Date): ServiceDate {
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

export function fromServiceDate(value: ServiceDate): Date {
  const y = Math.floor(value / 10000);
  const m = Math.floor(value / 100) % 100;
  const d = value % 100;
  return new Date(Date.UTC(y, m - 1, d));
}

/** 0 = Monday .. 6 = Sunday, matching the column order in calendar.txt. */
export function weekdayIndex(value: ServiceDate): number {
  return (fromServiceDate(value).getUTCDay() + 6) % 7;
}

export function addDays(value: ServiceDate, days: number): ServiceDate {
  const date = fromServiceDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return toServiceDate(date);
}

export function formatDate(value: ServiceDate): string {
  const s = String(value);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
