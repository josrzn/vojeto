import { GRADE_COLORS, GRADE_LABELS, DARK_BANDS } from "./grade.js";

interface Props {
  /** The band each sample falls in, as the chart above bands them. */
  bands: number[];
  /**
   * What each sample is being weighted by: kilometres or elapsed hours.
   *
   * Which one it is changes the answer, and that is the point. A tenth of the
   * distance spent at 8% is closer to a quarter of the afternoon.
   */
  domain: number[];
  /** "km" or a duration, for the sentence under the bar. */
  totalLabel: string;
  measure: "distance" | "time";
}

/** The share of a ride in each band, as fractions summing to one. */
export function shares(bands: number[], domain: number[]): number[] {
  const totals = GRADE_COLORS.map(() => 0);
  let sum = 0;
  for (let i = 1; i < domain.length; i++) {
    const weight = Math.max(0, (domain[i] ?? 0) - (domain[i - 1] ?? 0));
    const band = bands[i] ?? 0;
    sum += weight;
    // A band outside the ramp cannot come from `gradeBand`, so if one ever does
    // it is a bug. Its weight still counts towards the total, which leaves a
    // visible gap in the bar rather than quietly renormalising the rest to hide
    // it.
    if (totals[band] !== undefined) totals[band] += weight;
  }
  return sum > 0 ? totals.map((t) => t / sum) : totals;
}

/**
 * How the ride divides between kinds of riding, as one stacked bar.
 *
 * The profile answers "where is the climbing"; this answers "how much of the
 * day is climbing", which is the question you are actually asking when you pick
 * between six ways home. Reading it off the profile means integrating a wiggly
 * line by eye, and a fifth of a ride at 6–9% does not look like a fifth of
 * anything when it is spread over four separate ramps.
 *
 * Percentages are written on any segment wide enough to hold one. That is not
 * decoration: the pale end of the ramp sits below 3:1 against the page, so the
 * labels are what make those segments readable rather than merely visible.
 */
export function EffortMix({ bands, domain, totalLabel, measure }: Props) {
  const mix = shares(bands, domain);
  const spoken = mix
    .map((share, band) => (share > 0.005 ? `${Math.round(share * 100)}% ${GRADE_LABELS[band]}` : null))
    .filter(Boolean)
    .join(", ");

  return (
    <div className="mix">
      <div
        className="mix-bar"
        role="img"
        aria-label={`Share of the ride by gradient, by ${measure}: ${spoken}`}
      >
        {mix.map((share, band) =>
          share > 0 ? (
            <span
              key={band}
              className={DARK_BANDS.has(band) ? "mix-part on-dark" : "mix-part"}
              style={{ flexGrow: share, background: GRADE_COLORS[band] }}
              title={`${GRADE_LABELS[band]}: ${(share * 100).toFixed(0)}%`}
            >
              {/* Below about a twelfth of the width there is no room for "12%"
                  without it spilling into its neighbours. */}
              {share >= 0.085 && <span className="mix-figure">{Math.round(share * 100)}</span>}
            </span>
          ) : null,
        )}
      </div>
      <p className="mix-note">
        share of the {totalLabel}, by {measure}
      </p>
    </div>
  );
}
