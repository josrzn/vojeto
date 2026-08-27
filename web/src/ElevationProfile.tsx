import { useId, useMemo, useState } from "react";
import { GRADE_COLORS, GRADE_LABELS, bandSeries, gradeBand, type LoadedProfile } from "./grade.js";

interface Props {
  profile: LoadedProfile;
  /** Told the hovered sample index, so the map can show where you are. */
  onHover: (index: number | null) => void;
}

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

export function ElevationProfile({ profile, onHover }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();

  const geometry = useMemo(() => {
    const totalKm = profile.km.at(-1) ?? 1;
    const lo = Math.min(...profile.ele);
    const hi = Math.max(...profile.ele);
    const pad = Math.max(10, (hi - lo) * 0.15);
    const yLo = Math.max(0, lo - pad);
    const yHi = hi + pad;

    const plotW = WIDTH - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (km: number) => PAD.left + (km / totalKm) * plotW;
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

    // Banded once for the whole series, so a stretch keeps one colour instead
    // of flickering wherever the gradient brushes a threshold.
    const bands = bandSeries(profile.grade);

    let runStart = 1;
    const closeRun = (from: number, to: number, band: number) => {
      const top = [];
      for (let i = from - 1; i <= to; i++) {
        top.push(`${x(profile.km[i]!).toFixed(2)},${y(profile.ele[i]!).toFixed(2)}`);
      }
      areaByBand[band] +=
        `M${x(profile.km[from - 1]!).toFixed(2)},${base.toFixed(2)}` +
        top.map((p) => `L${p}`).join("") +
        `L${x(profile.km[to]!).toFixed(2)},${base.toFixed(2)}Z`;
      lineByBand[band] += `M${top.join("L")}`;
    };

    for (let i = 1; i < profile.km.length; i++) {
      const band = bands[i] ?? 0;
      const next = i + 1 < profile.km.length ? (bands[i + 1] ?? 0) : -1;
      if (band !== next) {
        closeRun(runStart, i, band);
        runStart = i + 1;
      }
    }

    return { x, y, areaByBand, lineByBand, totalKm, yLo, yHi, plotH, plotW };
  }, [profile]);

  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction =
      ((event.clientX - box.left) / box.width * WIDTH - PAD.left) / geometry.plotW;
    const index = Math.round(fraction * (profile.km.length - 1));
    const clamped = Math.max(0, Math.min(profile.km.length - 1, index));
    setHover(clamped);
    onHover(clamped);
  };

  const leave = () => {
    setHover(null);
    onHover(null);
  };

  const active = hover === null ? null : hover;

  return (
    <figure className="profile">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="profile-svg"
        role="img"
        aria-label={`Elevation profile: ${geometry.totalKm.toFixed(0)} kilometres, ${Math.round(
          geometry.yLo,
        )} to ${Math.round(geometry.yHi)} metres`}
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

        {active !== null && (
          <g>
            <line
              x1={geometry.x(profile.km[active]!)}
              x2={geometry.x(profile.km[active]!)}
              y1={PAD.top}
              y2={PAD.top + geometry.plotH}
              className="profile-crosshair"
            />
            <circle
              cx={geometry.x(profile.km[active]!)}
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
          {geometry.totalKm.toFixed(0)} km
        </text>
      </svg>

      <figcaption className="profile-readout">
        {active === null ? (
          <span className="profile-hint">Hover to read the climb at any point</span>
        ) : (
          <>
            <strong>{profile.km[active]!.toFixed(1)} km</strong>
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
    </figure>
  );
}
