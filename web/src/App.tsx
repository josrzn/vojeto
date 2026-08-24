import { useEffect, useMemo, useState } from "react";
import type { Plan, PlanDestination } from "../../src/build/buildPlan.js";
import { MapView } from "./MapView.js";
import { TripDetail } from "./TripDetail.js";

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; plan: Plan };

export function App() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [monthKey, setMonthKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

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

  const destinations = useMemo(
    () => [...(month?.destinations ?? [])].sort((a, b) => a.travelMinutes - b.travelMinutes),
    [month],
  );

  // Keep the selection only while it exists in the month being shown.
  useEffect(() => {
    if (selected && !destinations.some((d) => d.stationId === selected)) setSelected(null);
  }, [destinations, selected]);

  if (load.status === "loading") {
    return <div className="splash">Loading…</div>;
  }

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

  const chosen = destinations.find((d) => d.stationId === selected) ?? null;
  const ride = chosen ? (load.plan.rides[chosen.stationId] ?? null) : null;

  return (
    <div className="layout">
      <aside className="sidebar">
        <header className="masthead">
          <h1>Train out, bike back</h1>
          <p>
            From <strong>{load.plan.home.name}</strong>, off the train by{" "}
            <strong>{load.plan.settings.arriveBy}</strong>.
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
            Timetable for {month.date} · {destinations.length} destinations
          </p>
        )}

        <ul className="results">
          {destinations.map((destination) => (
            <ResultRow
              key={destination.stationId}
              destination={destination}
              ride={load.plan.rides[destination.stationId] ?? null}
              isSelected={destination.stationId === selected}
              onSelect={() => setSelected(destination.stationId)}
            />
          ))}
          {destinations.length === 0 && (
            <li className="empty">Nothing reachable in time this month.</li>
          )}
        </ul>

        <footer className="colophon">
          Feed {load.plan.feed.start} → {load.plan.feed.end}. Built{" "}
          {new Date(load.plan.generatedAt).toISOString().slice(0, 10)}.
        </footer>
      </aside>

      <main className="stage">
        <MapView
          plan={load.plan}
          destinations={destinations}
          selected={selected}
          onSelect={setSelected}
        />
        {chosen && (
          <TripDetail
            home={load.plan.home.name}
            destination={chosen}
            ride={ride}
            onClose={() => setSelected(null)}
          />
        )}
      </main>
    </div>
  );
}

function ResultRow({
  destination,
  ride,
  isSelected,
  onSelect,
}: {
  destination: PlanDestination;
  ride: Plan["rides"][string] | null;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={isSelected ? "result is-selected" : "result"}
        onClick={onSelect}
      >
        <span className="result-name">{destination.name}</span>
        <span className="result-train">
          {destination.departure} → {destination.arrival} · {destination.travel}
          {destination.transfers > 0 && ` · ${destination.transfers} change`}
          {destination.transfers > 1 && "s"}
        </span>
        {ride && (
          <span className="result-ride">
            🚲 {Math.round(ride.km)} km · +{ride.ascentMetres} m
            {ride.days > 1 && ` · ${ride.days} days`}
          </span>
        )}
      </button>
    </li>
  );
}
