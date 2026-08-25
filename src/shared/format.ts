/** 4.5 -> "4h30". Rounds to the nearest minute. */
export function formatHours(hours: number): string {
  return render(hours, Math.round);
}

/**
 * Same, but never rounds down.
 *
 * Used for "needs a 8h07 day": rounding 8.001 down to "8h00" against an 8 hour
 * budget would report the exact figure you already have as the fix.
 */
export function formatHoursCeil(hours: number): string {
  return render(hours, Math.ceil);
}

function render(hours: number, round: (value: number) => number): string {
  if (!Number.isFinite(hours)) return "—";
  const totalMinutes = round(Math.abs(hours) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${hours < 0 ? "-" : ""}${h}h${String(m).padStart(2, "0")}`;
}
