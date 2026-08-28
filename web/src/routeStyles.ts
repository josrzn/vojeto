import type { Plan } from "../../src/build/buildPlan.js";

/**
 * The ways home worth offering.
 *
 * BRouter profiles, named for what they mean rather than for what they are
 * called: "trekking" is a routing profile, "quiet roads" is a kind of day.
 * The first one is the proposal; the others are what the "other ways home"
 * button goes and fetches.
 */
export interface RouteStyle {
  id: string;
  label: string;
  profile: string;
}

export const ROUTE_STYLES: RouteStyle[] = [
  { id: "trekking", label: "Quiet roads", profile: "trekking" },
  { id: "fast", label: "Direct", profile: "fastbike" },
  { id: "gravel", label: "Gravel", profile: "gravel" },
];

/** Config's list when a plan shipped one, the built-in list otherwise. */
export function stylesFrom(plan: Plan | null): RouteStyle[] {
  const shipped = (plan?.settings as Partial<Plan["settings"]> | undefined)?.variants;
  if (!shipped?.length) return ROUTE_STYLES;
  return shipped.map((v) => ({ id: v.id, label: v.label, profile: v.profile }));
}

/** The preferred style, falling back to the first rather than to nothing. */
export function preferred(styles: RouteStyle[], id: string): RouteStyle {
  return styles.find((style) => style.id === id) ?? styles[0]!;
}
