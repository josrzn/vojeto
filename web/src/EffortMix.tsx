import { useState } from "react";
import { surfaceShares } from "../../src/bike/surface.js";
import {
  DARK_BANDS,
  GRADE_COLORS,
  GRADE_LABELS,
  SURFACE_COLORS,
  SURFACE_LABELS,
  SURFACES,
  type Surface,
} from "./grade.js";

interface Props {
  /** The band each sample falls in, as the chart above bands them. */
  bands: number[];
  /** What each sample is riding on. */
  surface: Surface[];
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

/** One segment of the bar: a share of the ride, and what to call it. */
interface Part {
  key: string;
  share: number;
  color: string;
  label: string;
  /** Written inside the segment when it is wide enough to hold it. */
  inline: string;
  dark: boolean;
  hatched: boolean;
}

type Division = "gradient" | "surface";

/** The share of a ride in each gradient band, as fractions summing to one. */
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
 * Gradient and surface are two divisions of the same ride, and the bar shows one
 * or the other. Both at once would need eight or nine segments and two keys in a
 * panel that is already tight, and nobody reads a ride as "steep *and* gravel"
 * in one glance anyway — you ask one question, then the other.
 *
 * The surface view is the quieter of the two: three segments wide enough to be
 * named in place, so it needs no key at all.
 */
export function EffortMix({ bands, surface, domain, totalLabel, measure }: Props) {
  const [division, setDivision] = useState<Division>("gradient");

  const parts: Part[] =
    division === "gradient"
      ? shares(bands, domain).map((share, band) => ({
          key: String(band),
          share,
          color: GRADE_COLORS[band]!,
          label: GRADE_LABELS[band]!,
          // Just the number: the key below the chart names the bands, and six
          // names would not fit across 320 pixels in any case.
          inline: `${Math.round(share * 100)}`,
          dark: DARK_BANDS.has(band),
          hatched: false,
        }))
      : surfaceParts(surface, domain);

  const spoken = parts
    .filter((part) => part.share > 0.005)
    .map((part) => `${Math.round(part.share * 100)}% ${part.label}`)
    .join(", ");

  return (
    <div className="mix">
      <div
        className="mix-bar"
        role="img"
        aria-label={`Share of the ride by ${division}, by ${measure}: ${spoken}`}
      >
        {parts.map((part) =>
          part.share > 0 ? (
            <span
              key={part.key}
              className={
                ["mix-part", part.dark ? "on-dark" : "", part.hatched ? "is-hatched" : ""]
                  .filter(Boolean)
                  .join(" ")
              }
              style={{ flexGrow: part.share, backgroundColor: part.color }}
              title={`${part.label}: ${(part.share * 100).toFixed(0)}%`}
            >
              {/* Below about a twelfth of the width there is no room for a
                  figure without it spilling into its neighbours; a named
                  segment needs roughly twice that. */}
              {part.share >= (part.inline.length > 3 ? 0.17 : 0.085) && (
                <span className="mix-figure">{part.inline}</span>
              )}
            </span>
          ) : null,
        )}
      </div>

      <p className="mix-note">
        <span>
          share of the {totalLabel}, by {measure}
        </span>
        <span className="mix-pick" role="group" aria-label="Divide the ride by">
          {(["gradient", "surface"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={division === option ? "axis-pick is-active" : "axis-pick"}
              aria-pressed={division === option}
              onClick={() => setDivision(option)}
            >
              {option}
            </button>
          ))}
        </span>
      </p>
    </div>
  );
}

/**
 * The three surface segments, always in the same order.
 *
 * "unrecorded" is hatched rather than merely pale: it is not a third kind of
 * ground, it is the absence of a reading, and a flat fill beside two solid ones
 * would present it as though it were a measurement.
 */
function surfaceParts(surface: Surface[], domain: number[]): Part[] {
  const totals = surfaceShares(surface, domain);
  const sum = SURFACES.reduce((total, name) => total + totals[name], 0);
  return SURFACES.map((name) => {
    const share = sum > 0 ? totals[name] / sum : 0;
    return {
      key: name,
      share,
      color: SURFACE_COLORS[name],
      label: SURFACE_LABELS[name],
      inline: `${SURFACE_LABELS[name]} ${Math.round(share * 100)}%`,
      dark: false,
      hatched: name === "unknown",
    };
  });
}
