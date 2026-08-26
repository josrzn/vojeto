import { useEffect, useMemo, useState } from "react";
import type { Plan } from "../../src/build/buildPlan.js";
import { MapView } from "./MapView.js";
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
  const month = useMemo(
    () => plan?.months.find((m) => m.key === monthKey) ?? plan?.months[0] ?? null,
    [plan, monthKey],
  );

  const corridors = useMemo(
    () => (plan && month ? groupIntoCorridors(month.destinations, plan.rides) : []),
    [plan, month],
  );

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
    <div className="layout">
      <aside className="sidebar">
        <header className="masthead">
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
                      return (
                        <li key={destination.stationId}>
                          <button
                            type="button"
                            className={
                              destination.stationId === selected ? "result is-selected" : "result"
                            }
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
          Feed {load.plan.feed.start} → {load.plan.feed.end}. Riding at {settings.speedKmh} km/h
          plus {settings.climbMetresPerHour} m climb an hour.
          {" "}Plan built {describeAge(load.plan.generatedAt)}
          {load.plan.field ? " with a ride-time field." : ", no ride-time field."}
        </footer>
      </aside>

      <main className="stage">
        <MapView
          plan={load.plan}
          destinations={corridors.flatMap((c) => c.destinations)}
          selected={selected}
          variant={activeVariant}
          frontierHours={
            chosen ? settings.budgetHours - chosen.travelMinutes / 60 : null
          }
          showField={showField && load.plan.field !== null}
          showNoTrain={showNoTrain}
          onSelect={(id) => {
            setSelected(id);
            setVariantId(null);
          }}
        />

        <div className="field-key">
          <h3>What you are looking at</h3>

          <ul className="key">
            <li>
              <span className="swatch swatch-train" /> train out, through the stops it
              calls at
            </li>
            <li>
              <span className="swatch swatch-ride" /> ride home
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
                  <span className="swatch swatch-hollow" /> station with no morning train
                  ({load.plan.noTrain.length})
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
          </ul>

          {load.plan.field && showField && (
            <p className="key-note">
              {chosen && activeVariant ? (
                <>
                  <span className="swatch swatch-dash" /> <strong>your limit today</strong>:{" "}
                  {formatHours(settings.budgetHours - chosen.travelMinutes / 60)} of riding
                  left after the train to {chosen.name}. The ride is{" "}
                  {formatHours(activeVariant.hours)}, so {chosen.name} falls{" "}
                  {activeVariant.feasible ? "inside" : "outside"} it.
                </>
              ) : (
                <>
                  Pick a station and a dashed line appears: the riding you would have left
                  after that train, so you can see what else was in reach.
                </>
              )}
            </p>
          )}
        </div>

      </main>
    </div>
  );
}
