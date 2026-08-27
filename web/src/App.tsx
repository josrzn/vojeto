import { useEffect, useMemo, useRef, useState } from "react";
import type { Plan } from "../../src/build/buildPlan.js";
import { MapView } from "./MapView.js";
import { SURFACES, type LoadedProfile } from "./grade.js";
import {
  curveFromLinearModel,
  describeCurve,
  type SpeedCurve,
  type SpeedCurves,
} from "../../src/bike/speed.js";
import { haversine } from "../../src/shared/geo.js";
import { TripDetail } from "./TripDetail.js";
import {
  bestVariant,
  formatHours,
  formatHoursCeil,
  formatMinutes,
  groupIntoCorridors,
} from "./corridors.js";

/**
 * How long ago the plan was generated.
 *
 * Shown because `npm run plan` writes into public/, which a built site only
 * picks up when it is rebuilt: a page that looks wrong is usually a page
 * showing an older plan than the one you just made.
 */
function describeAge(generatedAt: string): string {
  const minutes = Math.round((Date.now() - new Date(generatedAt).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return "at an unknown time";
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** One curve used for every surface, which is what a plan without them meant. */
const everySurface = (curve: SpeedCurve): SpeedCurves => ({
  paved: curve,
  unpaved: curve,
  unknown: curve,
});

/** Remembers a panel's open state between visits; never fatal if unavailable. */
function useRemembered(key: string, fallback: boolean) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? fallback : stored === "1";
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value ? "1" : "0");
    } catch {
      // A private window, or storage disabled. The preference simply does not
      // outlive the session.
    }
  }, [key, value]);
  return [value, setValue] as const;
}

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; plan: Plan };

export function App() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [monthKey, setMonthKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [openCorridors, setOpenCorridors] = useState<Set<string>>(new Set());
  const [showMisses, setShowMisses] = useState(false);
  const [showField, setShowField] = useState(true);
  const [showNoTrain, setShowNoTrain] = useState(false);
  const [showFrontier, setShowFrontier] = useState(false);
  const [profile, setProfile] = useState<LoadedProfile | null>(null);
  const [sidebarOpen, setSidebarOpen] = useRemembered("vojeto.sidebar", true);
  const [keyOpen, setKeyOpen] = useRemembered("vojeto.key", true);
  const selectedRow = useRef<HTMLLIElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("./data/plan.json")
      .then((response) => {
        if (!response.ok) throw new Error(`plan.json returned HTTP ${response.status}`);
        return response.json() as Promise<Plan>;
      })
      .then((plan) => {
        if (cancelled) return;
        setLoad({ status: "ready", plan });
        setMonthKey(plan.months[0]?.key ?? null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoad({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const plan = load.status === "ready" ? load.plan : null;

  // Elevation is fetched per variant rather than shipped in plan.json: at ~10 KB
  // each, all of them together would be several megabytes for data you only look
  // at one variant at a time.
  const elevationFile =
    plan && selected
      ? ((plan.rides[selected] ?? []).find((v) => v.id === variantId) ??
          (plan.rides[selected] ?? []).find((v) => v.feasible) ??
          (plan.rides[selected] ?? [])[0])?.elevationFile ?? null
      : null;

  useEffect(() => {
    if (!elevationFile) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    fetch(`./data/profiles/${elevationFile}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((raw: { step: number; points: number[][]; surfaces?: number[] }) => {
        if (cancelled) return;
        const km: number[] = [0];
        for (let i = 1; i < raw.points.length; i++) {
          const p = raw.points[i - 1]!;
          const q = raw.points[i]!;
          km.push(km[i - 1]! + haversine({ lon: p[0]!, lat: p[1]! }, { lon: q[0]!, lat: q[1]! }) / 1000);
        }
        const ele = raw.points.map((p) => p[2] ?? 0);
        const grade: number[] = [0];
        for (let i = 1; i < raw.points.length; i++) {
          const run = (km[i]! - km[i - 1]!) * 1000;
          grade.push(run > 0 ? ((ele[i]! - ele[i - 1]!) / run) * 100 : 0);
        }
        // A profile written before surfaces were shipped simply has none, and
        // "unknown" is exactly what that means.
        const surface = raw.points.map(
          (_, i) => SURFACES[raw.surfaces?.[i] ?? -1] ?? "unknown",
        );
        setProfile({ km, ele, grade, surface, at: raw.points.map((p) => [p[0]!, p[1]!]) });
      })
      .catch(() => {
        if (!cancelled) setProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [elevationFile]);
  const month = useMemo(
    () => plan?.months.find((m) => m.key === monthKey) ?? plan?.months[0] ?? null,
    [plan, monthKey],
  );

  const corridors = useMemo(
    () => (plan && month ? groupIntoCorridors(month.destinations, plan.rides) : []),
    [plan, month],
  );

  // Selection usually comes from clicking the map, so bring the matching row
  // into view rather than leaving it somewhere down an unscrolled list.
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  // Keep the selection only while it exists in the month being shown.
  useEffect(() => {
    if (!selected) return;
    const stillThere = corridors.some((c) => c.destinations.some((d) => d.stationId === selected));
    if (!stillThere) setSelected(null);
  }, [corridors, selected]);

  if (load.status === "loading") return <div className="splash">Loading…</div>;

  if (load.status === "error") {
    return (
      <div className="splash">
        <h1>No plan yet</h1>
        <p className="splash-detail">{load.message}</p>
        <p>
          Build one with <code>npm run ingest</code>, then <code>npm run plan</code>.
        </p>
      </div>
    );
  }

  const { settings, home, rides } = load.plan;

  // A plan.json built before speed became a curve carries the two scalars it
  // used instead. Read them rather than crashing on a missing curve: the page
  // then shows the numbers that plan was actually built with, which is the
  // truthful thing to do until it is rebuilt.
  const legacy = settings as Partial<{ speedKmh: number; climbMetresPerHour: number }>;
  const shipped: SpeedCurves | SpeedCurve | undefined = settings.speedByGradient;
  const curves: SpeedCurves = !shipped
    ? everySurface(curveFromLinearModel(legacy.speedKmh ?? 16, legacy.climbMetresPerHour ?? 600))
    : Array.isArray(shipped)
      ? everySurface(shipped as SpeedCurve)
      : (shipped as SpeedCurves);
  const chosen =
    corridors.flatMap((c) => c.destinations).find((d) => d.stationId === selected) ?? null;
  const variants = chosen ? (rides[chosen.stationId] ?? []) : [];
  const activeVariant =
    variants.find((v) => v.id === variantId) ?? bestVariant(variants) ?? null;

  const stationCount = corridors.reduce((n, c) => n + c.destinations.length, 0);

  // Stations the train reaches but the ride home overruns, cheapest first, so
  // the budget needed to bring one in is visible rather than guessed at.
  const outOfReach = load.plan.rejected
    .filter((r) => r.verdict === "overruns" && r.neededBudgetHours !== null)
    .sort((a, b) => a.neededBudgetHours! - b.neededBudgetHours!);

  const toggleCorridor = (name: string) =>
    setOpenCorridors((open) => {
      const next = new Set(open);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className={sidebarOpen ? "layout" : "layout is-collapsed"}>
      <aside className="sidebar" hidden={!sidebarOpen}>
        <header className="masthead">
          <button
            type="button"
            className="panel-toggle"
            onClick={() => setSidebarOpen(false)}
            aria-label="Hide the list"
            title="Hide the list"
          >
            ⟨
          </button>
          <h1>Train out, bike back</h1>
          <p>
            From <strong>{home.station.name}</strong>, off the train by{" "}
            <strong>{settings.arriveBy}</strong>, home within{" "}
            <strong>{formatHours(settings.budgetHours)}</strong>
            {settings.maxDays > 1 && ` over up to ${settings.maxDays} days`}.
          </p>
        </header>

        <nav className="months" aria-label="Month">
          {load.plan.months.map((m) => (
            <button
              key={m.key}
              type="button"
              className={m.key === month?.key ? "month is-active" : "month"}
              onClick={() => setMonthKey(m.key)}
            >
              {m.label.split(" ")[0]}
            </button>
          ))}
        </nav>

        {month && (
          <p className="month-note">
            {month.date} · {stationCount} stations on {corridors.length} lines
          </p>
        )}

        <ul className="corridors">
          {corridors.map((corridor) => {
            const isOpen = openCorridors.has(corridor.name);
            const holdsSelection = corridor.destinations.some((d) => d.stationId === selected);
            return (
              <li key={corridor.name} className="corridor">
                <button
                  type="button"
                  className={holdsSelection ? "corridor-head is-active" : "corridor-head"}
                  onClick={() => toggleCorridor(corridor.name)}
                  aria-expanded={isOpen}
                >
                  <span className="corridor-caret">{isOpen || holdsSelection ? "▾" : "▸"}</span>
                  <span className="corridor-name">{corridor.name}</span>
                  <span className="corridor-range">
                    {corridor.destinations.length} stations ·{" "}
                    {Number.isFinite(corridor.shortestRideKm)
                      ? `${Math.round(corridor.shortestRideKm)}–${Math.round(corridor.longestRideKm)} km back`
                      : `${formatMinutes(corridor.quickestTrainMinutes)}–${formatMinutes(corridor.slowestTrainMinutes)} out`}
                  </span>
                </button>

                {(isOpen || holdsSelection) && (
                  <ul className="results">
                    {corridor.destinations.map((destination) => {
                      const ride = bestVariant(rides[destination.stationId]);
                      const isSelected = destination.stationId === selected;
                      return (
                        <li
                          key={destination.stationId}
                          ref={isSelected ? selectedRow : null}
                        >
                          <button
                            type="button"
                            className={isSelected ? "result is-selected" : "result"}
                            onClick={() => {
                              setSelected(destination.stationId);
                              setVariantId(null);
                            }}
                          >
                            <span className="result-name">{destination.name}</span>
                            <span className="result-train">
                              {destination.departure} → {destination.arrival} ·{" "}
                              {destination.travel}
                              {destination.transfers > 0 &&
                                ` · ${destination.transfers} change${destination.transfers > 1 ? "s" : ""}` +
                                  ` (${destination.worstWaitMinutes} min)`}
                            </span>
                            {ride && (
                              <span className="result-ride">
                                🚲 {Math.round(ride.km)} km · +{ride.ascentMetres} m ·{" "}
                                {formatHours(ride.hours)}
                                {ride.days > 1 && ` · ${ride.days} days`}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
          {corridors.length === 0 && (
            <li className="empty">Nothing reachable that you could ride back from in time.</li>
          )}
        </ul>

        {outOfReach.length > 0 && (
          <div className="misses">
            <button
              type="button"
              className="misses-head"
              onClick={() => setShowMisses((v) => !v)}
              aria-expanded={showMisses}
            >
              {showMisses ? "▾" : "▸"} {outOfReach.length} just out of reach
            </button>
            {showMisses && (
              <ul className="miss-list">
                {outOfReach.map((miss) => (
                  <li key={miss.stationId}>
                    <span className="miss-name">{miss.name}</span>
                    <span className="miss-figures">
                      {Math.round(miss.km)} km · {formatHours(miss.hours)} riding +{" "}
                      {formatHours(miss.trainHours)} train
                    </span>
                    <span className="miss-need">
                      needs a {formatHoursCeil(miss.neededBudgetHours!)} day
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <footer className="colophon">
          Feed {load.plan.feed.start} → {load.plan.feed.end}. Riding at{" "}
          {describeCurve(curves.paved)}.
          {" "}Plan built {describeAge(load.plan.generatedAt)}
          {load.plan.field ? " with a ride-time field." : ", no ride-time field."}
        </footer>
      </aside>

      <main className="stage">
        {!sidebarOpen && (
          <button
            type="button"
            className="panel-reopen"
            onClick={() => setSidebarOpen(true)}
            title="Show the list"
          >
            ⟩ {stationCount} destinations
          </button>
        )}
        <MapView
          plan={load.plan}
          destinations={corridors.flatMap((c) => c.destinations)}
          selected={selected}
          variant={activeVariant}
          frontierHours={
            showFrontier && chosen ? settings.budgetHours - chosen.travelMinutes / 60 : null
          }
          showField={showField && load.plan.field !== null}
          showNoTrain={showNoTrain}
          profile={profile}
          hoverIndex={hoverIndex}
          onSelect={(id) => {
            setSelected(id);
            setVariantId(null);
          }}
        />

        <div className={keyOpen ? "field-key" : "field-key is-shut"}>
          <button
            type="button"
            className="field-key-head"
            onClick={() => setKeyOpen((open) => !open)}
            aria-expanded={keyOpen}
          >
            {keyOpen ? "▾" : "▸"} What you are looking at
          </button>

          {keyOpen && (
          <ul className="key">
            <li>
              <span className="swatch swatch-train" /> train out, through the stops it
              calls at
            </li>
            <li>
              <span className="swatch swatch-ride" /> ride home, shaded by gradient
            </li>
            <li>
              <span className="swatch swatch-dot" /> station with a morning train
            </li>
            {load.plan.noTrain.length > 0 && (
              <li>
                <label>
                  <input
                    type="checkbox"
                    checked={showNoTrain}
                    onChange={(e) => setShowNoTrain(e.target.checked)}
                  />
                  <span className="swatch swatch-hollow" /> station with no morning train (
                  {load.plan.noTrain.length})
                </label>
              </li>
            )}
            {load.plan.field && (
              <li>
                <label>
                  <input
                    type="checkbox"
                    checked={showField}
                    onChange={(e) => setShowField(e.target.checked)}
                  />
                  <span className="swatch swatch-ring" /> hours of riding home, from
                  anywhere
                </label>
              </li>
            )}
            {load.plan.field && showField && (
              <li>
                <label>
                  <input
                    type="checkbox"
                    checked={showFrontier}
                    onChange={(e) => setShowFrontier(e.target.checked)}
                  />
                  <span className="swatch swatch-dash" /> how far else you could have gone
                </label>
              </li>
            )}
          </ul>
          )}

          {keyOpen && chosen && activeVariant && (
            <p className="key-note">
              <strong>{chosen.name}</strong>: {formatHours(chosen.travelMinutes / 60)} on the
              train leaves {formatHours(settings.budgetHours - chosen.travelMinutes / 60)} for
              riding. This way home is {formatHours(activeVariant.hours)}, so it fits with{" "}
              {formatHours(Math.max(0, activeVariant.slackHours))} spare.
            </p>
          )}
        </div>

        {chosen && (
          <TripDetail
            destination={chosen}
            variants={variants}
            active={activeVariant}
            profile={profile}
            effort={{ curves }}
            onHoverProfile={setHoverIndex}
            onPickVariant={setVariantId}
            onClose={() => setSelected(null)}
          />
        )}
      </main>
    </div>
  );
}
