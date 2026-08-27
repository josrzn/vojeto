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
 * The longest flat ride that could still fit, used to skip routing requests for
 * destinations that cannot possibly work. Ignores climbing on purpose: any real
 * route is slower than this, so the bound stays safe.
 */
export function maxRideKm(trainHours: number, budget: Budget, model: EffortModel): number {
  const firstDay = Math.max(0, budget.budgetHours - trainHours);
  const laterDays = Math.max(0, budget.maxDays - 1) * budget.hoursPerDay;
  return (firstDay + laterDays) * model.speedKmh;
}

/**
 * Riding time elapsed at each sample of a profile, in hours.
 *
 * The same model as `rideHours`, applied step by step: a segment costs its
 * distance at the flat speed, plus whatever it climbs. Descents cost their
 * distance and nothing else — the model has no notion of going faster downhill,
 * so a descent is cheap rather than free.
 *
 * Monotonically increasing by construction, which is what makes it usable as an
 * axis. The last value equals `rideHours` over the same totals, so a chart drawn
 * against it ends where the ride's stated duration says it should.
 */
export function elapsedHours(km: number[], ele: number[], model: EffortModel): number[] {
  const out = [0];
  for (let i = 1; i < km.length; i++) {
    const run = Math.max(0, (km[i] ?? 0) - (km[i - 1] ?? 0));
    const rise = Math.max(0, (ele[i] ?? 0) - (ele[i - 1] ?? 0));
    out.push(out[i - 1]! + rideHours(run, rise, model));
  }
  return out;
}
