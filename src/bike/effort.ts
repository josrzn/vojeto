import { flatKmh, speedAt, type SpeedCurve } from "./speed.js";

/**
 * How long a ride takes, and whether it fits in the time you have.
 *
 * BRouter reports its own duration, but that figure comes out of the routing
 * profile's internal cost model and is not something you can reason about. This
 * integrates your own speed curve over the shape of the ground instead, so the
 * numbers move predictably when you change the settings — and so that a ride
 * that spends its afternoon descending is charged for descending.
 *
 * Every duration in the project comes from here.
 */
export interface EffortModel {
  /** Speed against gradient. The only thing that decides how long a ride takes. */
  curve: SpeedCurve;
}

export interface Budget {
  /** Total hours for the whole outing on day one, train included. */
  budgetHours: number;
  /** 1 for a there-and-back day; more to allow overnight stops. */
  maxDays: number;
  /** Riding hours available on each day after the first. */
  hoursPerDay: number;
  /**
   * Shortest ride worth catching a train for. Below this you may as well have
   * ridden out too, so the destination is not really a trip.
   */
  minHours: number;
}

export type Verdict = "fits" | "tooShort" | "overruns";

export interface Feasibility {
  feasible: boolean;
  verdict: Verdict;
  /** Days the ride needs, whether or not that fits within maxDays. */
  days: number;
  /** Spare hours on the last day. Negative means it does not fit. */
  slackHours: number;
  /**
   * The `budgetHours` this ride would need, train included. Null unless the
   * verdict is "overruns" — it is what tells you how much more time Lyon wants.
   */
  neededBudgetHours: number | null;
}

/**
 * Slack for floating-point comparison, in hours — about four milliseconds.
 *
 * Without it `neededBudgetHours` is a lie: (train + ride) - train can land a
 * fraction below `ride`, so the very budget we advertise would reject the trip.
 * These are estimates accurate to tens of minutes, so comparing them to the
 * last bit is false precision regardless.
 */
const EPSILON = 1e-6;

/**
 * How long one stretch of road takes.
 *
 * `km` is measured along the road and `riseMetres` is the elevation change over
 * it, signed: a descent is a negative rise and is charged at descending speed.
 *
 * Only meaningful over a stretch long enough to have a gradient worth the name.
 * Feed it the router's raw vertices — sometimes three metres apart, with
 * elevations off a thirty-metre model — and the gradients are noise, which a
 * curve amplifies where the old linear model quietly averaged it away. Callers
 * resample and smooth first; `elapsedHours` is the one to reach for.
 */
export function segmentHours(km: number, riseMetres: number, model: EffortModel): number {
  if (km <= 0) return 0;
  const gradient = riseMetres / (10 * km);
  return km / speedAt(model.curve, gradient);
}

/**
 * Splits the riding across days and reports whether it fits.
 *
 * Day one is what is left of the budget once the train journey is paid for;
 * later days get `hoursPerDay` each.
 */
export function fitsBudget(trainHours: number, hours: number, budget: Budget): Feasibility {
  // Checked before anything else: a ride too short to be worth the fare is not
  // rescued by having plenty of time, or by being spread over several days.
  if (hours < budget.minHours - EPSILON) {
    return {
      feasible: false,
      verdict: "tooShort",
      days: 1,
      slackHours: budget.budgetHours - trainHours - hours,
      neededBudgetHours: null,
    };
  }

  const overruns = (slackHours: number): Feasibility => ({
    feasible: false,
    verdict: "overruns",
    days: Infinity,
    slackHours,
    // What the whole outing would take if you simply allowed the time.
    neededBudgetHours: trainHours + hours,
  });

  const firstDay = budget.budgetHours - trainHours;
  if (firstDay <= 0) return overruns(firstDay);
  if (hours <= firstDay + EPSILON) {
    return {
      feasible: true,
      verdict: "fits",
      days: 1,
      slackHours: firstDay - hours,
      neededBudgetHours: null,
    };
  }
  if (budget.maxDays <= 1 || budget.hoursPerDay <= 0) return overruns(firstDay - hours);

  const remaining = hours - firstDay;
  const extraDays = Math.ceil(remaining / budget.hoursPerDay - EPSILON);
  const days = 1 + extraDays;
  if (days > budget.maxDays) return { ...overruns(firstDay - hours), days };
  return {
    feasible: true,
    verdict: "fits",
    days,
    slackHours: extraDays * budget.hoursPerDay - remaining,
    neededBudgetHours: null,
  };
}

/**
 * Slack on the pruning bound below, as a fraction.
 *
 * A rolling route is always slower than the flat speed — a kilometre up at 5%
 * costs far more than the matching kilometre down gives back — so for a route
 * that starts and ends at the same height the flat speed is a true ceiling. A
 * ride home does not: from a station a few hundred metres above Roanne the
 * average can beat it slightly. This covers that, and costs only a few wasted
 * routing requests if it is too generous.
 */
const BOUND_SLACK = 0.15;

/**
 * The longest ride that could still fit, used to skip routing requests for
 * destinations that cannot possibly work.
 *
 * Deliberately optimistic: excluding a station that would in fact have worked
 * is a bug you would never see, while including one that does not costs a
 * request and then shows up as a rejection you can read.
 */
export function maxRideKm(trainHours: number, budget: Budget, model: EffortModel): number {
  const firstDay = Math.max(0, budget.budgetHours - trainHours);
  const laterDays = Math.max(0, budget.maxDays - 1) * budget.hoursPerDay;
  return (firstDay + laterDays) * flatKmh(model.curve) * (1 + BOUND_SLACK);
}

/**
 * Riding time elapsed at each sample of a profile, in hours.
 *
 * This is the ride duration: the last value is what the whole thing takes, and
 * every intermediate value is where you are in it. One function, so the chart's
 * time axis, the headline figure and the day boundaries cannot disagree.
 *
 * Expects an evenly resampled, smoothed profile — see `segmentHours`. Strictly
 * increasing, since every speed on the curve is positive, which is what makes it
 * usable as an axis.
 */
export function elapsedHours(km: number[], ele: number[], model: EffortModel): number[] {
  const out = [0];
  for (let i = 1; i < km.length; i++) {
    const run = Math.max(0, (km[i] ?? 0) - (km[i - 1] ?? 0));
    const rise = (ele[i] ?? 0) - (ele[i - 1] ?? 0);
    out.push(out[i - 1]! + segmentHours(run, rise, model));
  }
  return out;
}

/** What a whole profile takes, in hours. */
export function rideHours(km: number[], ele: number[], model: EffortModel): number {
  return elapsedHours(km, ele, model).at(-1) ?? 0;
}
