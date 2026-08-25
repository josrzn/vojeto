/**
 * How long a ride takes, and whether it fits in the time you have.
 *
 * BRouter reports its own duration, but that figure comes out of the profile's
 * internal cost model and is not something you can reason about. This uses the
 * classic touring estimate instead — flat speed plus a climbing allowance — so
 * the numbers move predictably when you change the settings.
 */
export interface EffortModel {
  /** Average moving speed on the flat. */
  speedKmh: number;
  /** Metres of ascent absorbed per hour, on top of the flat-speed time. */
  climbMetresPerHour: number;
}

export interface Budget {
  /** Total hours for the whole outing on day one, train included. */
  budgetHours: number;
  /** 1 for a there-and-back day; more to allow overnight stops. */
  maxDays: number;
  /** Riding hours available on each day after the first. */
  hoursPerDay: number;
}

export interface Feasibility {
  feasible: boolean;
  /** Days the ride needs, whether or not that fits within maxDays. */
  days: number;
  /** Spare hours on the last day. Negative means it does not fit. */
  slackHours: number;
}

export function rideHours(km: number, ascentMetres: number, model: EffortModel): number {
  const flat = model.speedKmh > 0 ? km / model.speedKmh : Infinity;
  const climb = model.climbMetresPerHour > 0 ? ascentMetres / model.climbMetresPerHour : 0;
  return flat + climb;
}

/**
 * Splits the riding across days and reports whether it fits.
 *
 * Day one is what is left of the budget once the train journey is paid for;
 * later days get `hoursPerDay` each.
 */
export function fitsBudget(trainHours: number, hours: number, budget: Budget): Feasibility {
  const firstDay = budget.budgetHours - trainHours;
  if (firstDay <= 0) {
    return { feasible: false, days: Infinity, slackHours: firstDay };
  }
  if (hours <= firstDay) {
    return { feasible: true, days: 1, slackHours: firstDay - hours };
  }
  if (budget.maxDays <= 1 || budget.hoursPerDay <= 0) {
    return { feasible: false, days: Infinity, slackHours: firstDay - hours };
  }

  const remaining = hours - firstDay;
  const extraDays = Math.ceil(remaining / budget.hoursPerDay);
  const days = 1 + extraDays;
  return {
    feasible: days <= budget.maxDays,
    days,
    slackHours: extraDays * budget.hoursPerDay - remaining,
  };
}

/**
 * The longest flat ride that could still fit, used to skip routing requests for
 * destinations that cannot possibly work. Ignores climbing on purpose: any real
 * route is slower than this, so the bound stays safe.
 */
export function maxRideKm(trainHours: number, budget: Budget, model: EffortModel): number {
  const firstDay = Math.max(0, budget.budgetHours - trainHours);
  const laterDays = Math.max(0, budget.maxDays - 1) * budget.hoursPerDay;
  return (firstDay + laterDays) * model.speedKmh;
}
