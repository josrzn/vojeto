import { useId, useMemo, useState } from "react";
import { elapsedHours, type EffortModel } from "../../src/bike/effort.js";
import { formatHours } from "./corridors.js";
import { EffortMix } from "./EffortMix.js";
import { GRADE_COLORS, GRADE_LABELS, bandSeries, gradeBand, type LoadedProfile } from "./grade.js";

interface Props {
  profile: LoadedProfile;
  /** The touring model, so the chart can be drawn against time as well as distance. */
  effort: EffortModel;
  /** The ride's stated duration, which the time axis is made to end on. */
  totalHours: number;
  /** Told the hovered sample index, so the map can show where you are. */
  onHover: (index: number | null) => void;
}

type Axis = "km" | "time";

const WIDTH = 320;
const HEIGHT = 118;
const PAD = { top: 8, right: 6, bottom: 16, left: 30 };

/** Rounded, human tick steps for the elevation axis. */
function ticks(min: number, max: number): number[] {
  const span = Math.max(1, max - min);
  const rough = span / 3;
  const step = [10, 20, 25, 50, 100, 200, 250, 500].find((s) => s >= rough) ?? 1000;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}

/**
 * Interior gridlines for the time axis, at round durations.
 *
 * Only the time axis gets them. Reading a climb's width as "about forty
 * minutes" is the whole reason for this axis, and that reading needs something
 * to measure against; distance is already the axis you can eyeball.
 */
export function hourTicks(totalHours: number): number[] {
  const step =
    [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12].find((s) => totalHours / s <= 6) ?? totalHours / 6;
  const out: number[] = [];
  // Half a step of clearance at the end, or the last tick prints under the
  // total sitting at the right-hand edge.
  for (let v = step; v < totalHours - step / 2; v += step) out.push(Number(v.toFixed(2)));
  return out;
}

/** The sample nearest a fraction of the way along a monotonic domain. */
export function indexAtFraction(domain: number[], fraction: number): number {
  const total = domain.at(-1) ?? 0;
  const target = Math.max(0, Math.min(1, fraction)) * total;
  let lo = 0;
  let hi = domain.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (domain[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  const before = Math.max(0, lo - 1);
  return target - domain[before]! < domain[lo]! - target ? before : lo;
}

export function ElevationProfile({ profile, effort, totalHours, onHover }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const [axis, setAxis] = useState<Axis>("km");
  const clipId = useId();

  // Where you are in the ride, in hours, at every sample.
  //
  // The same calculation the plan ran: this profile is the one the duration was
  // integrated over, so the two agree to within the rounding that shipping it
  // costs. Scaled onto the stated total anyway, because an axis ending at a
  // time the panel above it contradicts would be worse than a scaled one, and
  // because it keeps the chart honest if the plan is older than the code.
  const elapsed = useMemo(() => {
    const raw = elapsedHours(profile.km, profile.ele, profile.surface, effort);
    const last = raw.at(-1) ?? 0;
    if (!Number.isFinite(last) || last <= 0 || !Number.isFinite(totalHours) || totalHours <= 0) {
      return null;
    }
    const scale = totalHours / last;
    return raw.map((hours) => hours * scale);
  }, [profile, effort, totalHours]);

  const showTime = axis === "time" && elapsed !== null;
  const domain = showTime ? elapsed! : profile.km;

  // Banded once for the whole series, so a stretch keeps one colour instead of
  // flickering wherever the gradient brushes a threshold. Shared with the mix
  // bar, which has to divide the ride the same way the chart colours it.
  const bands = useMemo(() => bandSeries(profile.grade), [profile]);

  const geometry = useMemo(() => {
    const total = domain.at(-1) || 1;
    const lo = Math.min(...profile.ele);
    const hi = Math.max(...profile.ele);
    const pad = Math.max(10, (hi - lo) * 0.15);
    const yLo = Math.max(0, lo - pad);
    const yHi = hi + pad;

    const plotW = WIDTH - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (value: number) => PAD.left + (value / total) * plotW;
    const y = (ele: number) => PAD.top + plotH - ((ele - yLo) / (yHi - yLo)) * plotH;

    // One path per band for the line and one for the fill, so the whole chart
    // is ten paths rather than hundreds. The fill is what carries the reading:
    // the area is the largest thing on screen, so it is the channel that must
    // encode gradient, not a flat wash that makes an easy ride look hard.
    //
    // Contiguous samples in the same band become a single polygon. Emitting one
    // quad per sample instead leaves a hairline seam at every shared edge where
    // the fills antialias against each other, which reads as vertical banding
    // across ground that is actually uniform.
    const base = PAD.top + plotH;
    const lineByBand: string[] = GRADE_COLORS.map(() => "");
    const areaByBand: string[] = GRADE_COLORS.map(() => "");

    let runStart = 1;
    const closeRun = (from: number, to: number, band: number) => {
      const top = [];
      for (let i = from - 1; i <= to; i++) {
        top.push(`${x(domain[i]!).toFixed(2)},${y(profile.ele[i]!).toFixed(2)}`);
      }
      areaByBand[band] +=
        `M${x(domain[from - 1]!).toFixed(2)},${base.toFixed(2)}` +
        top.map((p) => `L${p}`).join("") +
        `L${x(domain[to]!).toFixed(2)},${base.toFixed(2)}Z`;
      lineByBand[band] += `M${top.join("L")}`;
    };

    for (let i = 1; i < domain.length; i++) {
      const band = bands[i] ?? 0;
      const next = i + 1 < domain.length ? (bands[i + 1] ?? 0) : -1;
      if (band !== next) {
        closeRun(runStart, i, band);
        runStart = i + 1;
      }
    }

    return { x, y, areaByBand, lineByBand, total, yLo, yHi, plotH, plotW };
  }, [profile, domain, bands]);

  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction =
      ((event.clientX - box.left) / box.width * WIDTH - PAD.left) / geometry.plotW;
    const index = indexAtFraction(domain, fraction);
    setHover(index);
    onHover(index);
  };

  const leave = () => {
    setHover(null);
    onHover(null);
  };

  const active = hover === null ? null : hover;
  const totalKm = profile.km.at(-1) ?? 0;
  const endLabel = showTime ? formatHours(geometry.total) : `${geometry.total.toFixed(0)} km`;

  return (
    <figure className="profile">
      <div className="profile-axis-pick" role="group" aria-label="Horizontal axis">
        <button
          type="button"
          className={axis === "km" ? "axis-pick is-active" : "axis-pick"}
          aria-pressed={axis === "km"}
          onClick={() => setAxis("km")}
        >
          distance
        </button>
        <button
          type="button"
          className={showTime ? "axis-pick is-active" : "axis-pick"}
          aria-pressed={showTime}
          disabled={elapsed === null}
          onClick={() => setAxis("time")}
          title="Stretch the chart by riding time: climbs get wider, descents narrower"
        >
          time
        </button>
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="profile-svg"
        role="img"
        aria-label={
          showTime
            ? `Elevation profile against riding time: ${formatHours(geometry.total)}, ${Math.round(
                geometry.yLo,
              )} to ${Math.round(geometry.yHi)} metres`
            : `Elevation profile: ${geometry.total.toFixed(0)} kilometres, ${Math.round(
                geometry.yLo,
              )} to ${Math.round(geometry.yHi)} metres`
        }
        onPointerMove={move}
        onPointerLeave={leave}
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD.left} y={PAD.top} width={geometry.plotW} height={geometry.plotH} />
          </clipPath>
        </defs>

        {ticks(geometry.yLo, geometry.yHi).map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={geometry.y(tick)}
              y2={geometry.y(tick)}
              className="profile-grid"
            />
            <text x={PAD.left - 4} y={geometry.y(tick) + 3} className="profile-tick">
              {tick}
            </text>
          </g>
        ))}

        <g clipPath={`url(#${clipId})`}>
          {geometry.areaByBand.map((d, band) =>
            d ? <path key={band} d={d} fill={GRADE_COLORS[band]} className="profile-area" /> : null,
          )}
        </g>

        {geometry.lineByBand.map((d, band) =>
          d ? <path key={band} d={d} stroke={GRADE_COLORS[band]} className="profile-line" /> : null,
        )}

        {showTime &&
          hourTicks(geometry.total).map((tick) => (
            <g key={tick}>
              <line
                x1={geometry.x(tick)}
                x2={geometry.x(tick)}
                y1={PAD.top}
                y2={PAD.top + geometry.plotH}
                className="profile-hourline"
              />
              <text x={geometry.x(tick)} y={HEIGHT - 4} className="profile-tick profile-tick-mid">
                {formatHours(tick)}
              </text>
            </g>
          ))}

        {active !== null && (
          <g>
            <line
              x1={geometry.x(domain[active]!)}
              x2={geometry.x(domain[active]!)}
              y1={PAD.top}
              y2={PAD.top + geometry.plotH}
              className="profile-crosshair"
            />
            <circle
              cx={geometry.x(domain[active]!)}
              cy={geometry.y(profile.ele[active]!)}
              r={4}
              fill={GRADE_COLORS[gradeBand(profile.grade[active] ?? 0)]}
              className="profile-dot"
            />
          </g>
        )}

        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={PAD.top + geometry.plotH}
          y2={PAD.top + geometry.plotH}
          className="profile-axis"
        />
        <text x={PAD.left} y={HEIGHT - 4} className="profile-tick profile-tick-start">
          0
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 4} className="profile-tick profile-tick-end">
          {endLabel}
        </text>
      </svg>

      <figcaption className="profile-readout">
        {active === null ? (
          <span className="profile-hint">
            {showTime
              ? `Widths are riding time — ${formatHours(geometry.total)} over ${totalKm.toFixed(0)} km`
              : "Hover to read the climb at any point"}
          </span>
        ) : (
          <>
            <strong>{profile.km[active]!.toFixed(1)} km</strong>
            {elapsed && (
              <>
                <span> · </span>
                <strong>{formatHours(elapsed[active]!)}</strong>
              </>
            )}
            <span> · </span>
            <strong>{Math.round(profile.ele[active]!)} m</strong>
            <span> · </span>
            <strong>{(profile.grade[active] ?? 0).toFixed(1)}%</strong>
            <span className="profile-band">
              {" "}
              {GRADE_LABELS[gradeBand(profile.grade[active] ?? 0)]}
            </span>
          </>
        )}
      </figcaption>

      <ul className="grade-key">
        {GRADE_LABELS.map((label, band) => (
          <li key={label}>
            <span
              className="grade-swatch"
              style={{ background: GRADE_COLORS[band], color: GRADE_COLORS[band] }}
            />
            {label}
          </li>
        ))}
      </ul>

      <EffortMix
        bands={bands}
        surface={profile.surface}
        domain={domain}
        totalLabel={showTime ? formatHours(geometry.total) : `${totalKm.toFixed(0)} km`}
        measure={showTime ? "time" : "distance"}
      />

    </figure>
  );
}
