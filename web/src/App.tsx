import { useEffect, useMemo, useRef, useState } from "react";
import type { Plan, PlanDestination, PlanRideVariant } from "../../src/build/buildPlan.js";
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
import { SettingsPanel } from "./SettingsPanel.js";
import { HomePicker } from "./HomePicker.js";
import { Timetable } from "./timetableClient.js";
import type { Station } from "./timetableService.js";
import { explore, quickestTrains, sameHome, type Home } from "./explore.js";
import { routeNearestFirst, type Progress } from "./routeHome.js";
import { maxRideKm } from "../../src/bike/effort.js";
import { parseTime } from "../../src/gtfs/time.js";
import { reckon } from "./budget.js";
import type { Budget } from "../../src/bike/effort.js";
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

/**
 * The budget the user is looking at, which is the plan's own until they say
 * otherwise.
 *
 * Held as "what the user chose, or nothing yet" rather than as a copy of the
 * plan's settings. A copy would have to be taken before the plan has loaded —
 * there is nothing to copy on the first render — and would then never catch up,
 * which showed as the view being marked "adjusted" when nobody had touched it.
 *
 * A remembered choice is clamped to the plan it is applied to on every render:
 * a budget wider than the file would promise stations that were never routed.
 */
function useBudget(built: Budget) {
  const [chosen, setChosen] = useState<Partial<Budget> | null>(readStoredBudget);

  const budget = useMemo<Budget>(() => {
    if (!chosen) return built;
    return {
      budgetHours: clamp(chosen.budgetHours, built.budgetHours),
      minHours: clamp(chosen.minHours, Math.max(1, built.budgetHours / 2)),
      maxDays: clamp(chosen.maxDays, built.maxDays),
      hoursPerDay: clamp(chosen.hoursPerDay, built.hoursPerDay),
    };
  }, [chosen, built]);

  const choose = (next: Budget) => {
    setChosen(next);
    try {
      localStorage.setItem("vojeto.budget", JSON.stringify(next));
    } catch {
      // A private window, or storage disabled: the choice holds for this
      // session and no longer.
    }
  };
  return [budget, choose] as const;
}

function readStoredBudget(): Partial<Budget> | null {
  try {
    const stored = localStorage.getItem("vojeto.budget");
    return stored ? (JSON.parse(stored) as Partial<Budget>) : null;
  } catch {
    return null;
  }
}

const clamp = (value: number | undefined, ceiling: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(value, ceiling) : ceiling;

/** Destinations found by querying the timetable here, rather than read from the file. */
interface Live {
  home: Home;
  monthKey: string;
  destinations: PlanDestination[];
  outOfRange: number;
  querying: boolean;
}

/**
 * Where the browser routes when the plan does not say.
 *
 * The public instance, the same one `npm run plan` defaults to. It is donated
 * hardware, which is why routing starts on a click rather than on every change
 * of mind, and why requests go one at a time.
 */
const BROUTER_FALLBACK = "https://brouter.de/brouter";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [homeOpen, setHomeOpen] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [picked, setPicked] = useState<Home | null>(null);
  const [stations, setStations] = useState<Station[] | null>(null);
  const [timetableError, setTimetableError] = useState<string | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [liveRides, setLiveRides] = useState<Record<string, PlanRideVariant[]>>({});
  const [routing, setRouting] = useState<Progress | null>(null);
  const timetable = useRef<Timetable | null>(null);
  const routingRun = useRef<AbortController | null>(null);
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

  const built: Budget = useMemo(
    () => ({
      budgetHours: plan?.settings.budgetHours ?? 10,
      minHours: plan?.settings.minRideHours ?? 0,
      maxDays: plan?.settings.maxDays ?? 1,
      hoursPerDay: plan?.settings.hoursPerDay ?? 6,
    }),
    [plan],
  );
  const [budget, setBudget] = useBudget(built);

  const builtHome: Home = useMemo(
    () => ({
      stationId: plan?.home.station.stationId ?? "",
      name: plan?.home.station.name ?? "",
      at: { lat: plan?.home.station.lat ?? 0, lon: plan?.home.station.lon ?? 0 },
      rideTo: plan?.home.rideTo ?? { lat: 0, lon: 0 },
    }),
    [plan],
  );
  const current = picked ?? builtHome;
  const offPlan = plan !== null && !sameHome(current, builtHome);

  // The timetable is 800 KB and only wanted by someone who is going to move the
  // home, so it is fetched when the picker is first opened rather than on load.
  useEffect(() => {
    if (!homeOpen || timetable.current) return;
    const client = new Timetable();
    timetable.current = client;
    client
      .load()
      .then((loaded) => setStations(loaded.stations))
      .catch((error: unknown) =>
        setTimetableError(error instanceof Error ? error.message : String(error)),
      );
  }, [homeOpen]);


  // Elevation is fetched per variant rather than shipped in plan.json: at ~10 KB
  // each, all of them together would be several megabytes for data you only look
  // at one variant at a time.
  const month = useMemo(
    () => plan?.months.find((m) => m.key === monthKey) ?? plan?.months[0] ?? null,
    [plan, monthKey],
  );

  // Re-query whenever the home or the month moves off the plan. The plan's own
  // home needs no query: its answers are in the file, with rides attached.
  useEffect(() => {
    const client = timetable.current;
    if (!plan || !month || !client || !offPlan) {
      setLive(null);
      return;
    }
    routingRun.current?.abort();
    setLiveRides({});
    setRouting(null);

    let cancelled = false;
    setLive((previous) =>
      previous && sameHome(previous.home, current) && previous.monthKey === month.key
        ? { ...previous, querying: true }
        : { home: current, monthKey: month.key, destinations: [], outOfRange: 0, querying: true },
    );

    client
      .reachable({
        date: Number(month.date.replaceAll("-", "")),
        origin: current.stationId,
        earliestDeparture: 5 * 3600,
        arriveBy: parseTime(plan.settings.arriveBy),
        arriveNoEarlierThan: 6 * 3600,
        maxTravelSeconds: 4 * 3600,
        maxTransfers: plan.settings.maxTransfers,
        minTransferSeconds: plan.settings.minTransferMinutes * 60,
        maxTransferSeconds: plan.settings.maxTransferMinutes * 60,
      })
      .then((itineraries) => {
        if (cancelled) return;
        const found = explore(itineraries, current.rideTo, budget, { curves });
        setLive({ home: current, monthKey: month.key, ...found, querying: false });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setTimetableError(error instanceof Error ? error.message : String(error));
        setLive(null);
      });

    return () => {
      cancelled = true;
    };
    // `current` and `curves` are rebuilt each render; the identity that matters
    // is the home's own, which sameHome decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, month?.key, offPlan, current.stationId, current.rideTo.lat, current.rideTo.lon, budget]);

  // Everything the budget decides is re-decided here rather than read out of
  // the file, so the sliders move the map without re-routing anything. At the
  // plan's own settings this reproduces the file exactly.
  /**
   * Routes the live destinations, nearest first, filling them in as they land.
   *
   * Started deliberately rather than on every change: each station is a request
   * to donated hardware, and a home moved three times while someone makes up
   * their mind should not cost three hundred of them.
   */
  const routeAll = () => {
    if (!plan || !live || live.querying) return;
    const spec = plan.settings ? { id: "direct", label: "Direct", profile: "fastbike" } : null;
    if (!spec) return;

    routingRun.current?.abort();
    const run = new AbortController();
    routingRun.current = run;
    setLiveRides({});

    const candidates = live.destinations.map((destination) => ({
      stationId: destination.stationId,
      name: destination.name,
      at: { lat: destination.lat, lon: destination.lon },
      trainHours: destination.travelMinutes / 60,
      crowKm: haversine(current.rideTo, destination) / 1000,
    }));

    void routeNearestFirst(
      candidates,
      current.rideTo,
      spec,
      {
        baseUrl: plan.settings.brouterUrl || BROUTER_FALLBACK,
        effort: { curves },
        budget,
        trainHours: 0,
        profileStepMetres: 100,
      },
      (stationId, variant) =>
        setLiveRides((rides) => ({ ...rides, [stationId]: [variant] })),
      setRouting,
      run.signal,
    );
  };

  // Off the plan's own home there are no routed rides yet, so the list is the
  // train half only. `reckon` needs rides to judge anything, so it is not asked.
  const reckoned = useMemo(
    () =>
      plan && month && !offPlan
        ? reckon(month.destinations, plan.rides, plan.trainHours ?? {}, budget)
        : null,
    [plan, month, budget, offPlan],
  );

  const shownDestinations = offPlan
    ? (live?.destinations ?? [])
    : (reckoned?.destinations ?? []);

  const shownRides = offPlan ? liveRides : (reckoned?.rides ?? {});

  const corridors = useMemo(
    () => groupIntoCorridors(shownDestinations, shownRides),
    [shownDestinations, shownRides],
  );

  const elevationFile = selected
    ? ((shownRides[selected] ?? []).find((v) => v.id === variantId) ??
        (shownRides[selected] ?? []).find((v) => v.feasible) ??
        (shownRides[selected] ?? [])[0])?.elevationFile ?? null
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

  const { settings, home } = load.plan;
  const rides = shownRides;

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
  const narrowed =
    budget.budgetHours !== built.budgetHours ||
    budget.minHours !== built.minHours ||
    budget.maxDays !== built.maxDays ||
    budget.hoursPerDay !== built.hoursPerDay;

  const seen = new Set<string>();
  const outOfReach = [...(reckoned?.rejected ?? []), ...load.plan.rejected]
    .filter((r) => r.verdict === "overruns" && r.neededBudgetHours !== null)
    .filter((r) => (seen.has(r.stationId) ? false : seen.add(r.stationId)))
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
          <span className="masthead-controls">
            <button
              type="button"
              className="settings-open"
              onClick={() => setHomeOpen((open) => !open)}
              aria-expanded={homeOpen}
            >
              {offPlan ? "start · moved" : "start"}
            </button>
            <button
              type="button"
              className="settings-open"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
            >
              {narrowed ? "your day · adjusted" : "your day"}
            </button>
          </span>
          <p>
            From <strong>{current.name}</strong>, off the train by{" "}
            <strong>{settings.arriveBy}</strong>, home within{" "}
            <strong>{formatHours(budget.budgetHours)}</strong>
            {budget.maxDays > 1 && ` over up to ${budget.maxDays} days`}.
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

        {homeOpen && (
          <HomePicker
            stations={stations}
            loading={stations === null && timetableError === null}
            error={timetableError}
            home={current}
            built={builtHome}
            placing={placing}
            onPick={(next) => {
              setPicked(next);
              setSelected(null);
              setPlacing(false);
            }}
            onPlace={setPlacing}
            onClose={() => {
              setHomeOpen(false);
              setPlacing(false);
            }}
          />
        )}

        {offPlan && (
          <div className="off-plan">
            <p>
              {live?.querying
                ? "Asking the timetable…"
                : `${shownDestinations.length} stations reachable by train${
                    live && live.outOfRange > 0
                      ? `, ${live.outOfRange} beyond any ride home`
                      : ""
                  }.`}
            </p>
            {routing === null ? (
              <>
                <p>
                  Nothing is routed from here yet, so there are no distances or
                  gradients. Finding them is one request to brouter.de per
                  station, a second apart.
                </p>
                <button
                  type="button"
                  className="settings-reset"
                  onClick={routeAll}
                  disabled={live === null || live.querying || shownDestinations.length === 0}
                >
                  Route {shownDestinations.length} rides home
                </button>
              </>
            ) : (
              <p>
                {routing.done < routing.total
                  ? `Routing, nearest first — ${routing.done} of ${routing.total}.`
                  : `Routed ${routing.total - routing.failed.length} of ${routing.total}.`}
                {routing.failed.length > 0 &&
                  ` No route home from ${routing.failed.slice(0, 3).join(", ")}${
                    routing.failed.length > 3 ? ` and ${routing.failed.length - 3} more` : ""
                  }.`}
              </p>
            )}
          </div>
        )}

        {settingsOpen && (
          <SettingsPanel
            budget={budget}
            built={built}
            onChange={setBudget}
            onClose={() => setSettingsOpen(false)}
          />
        )}

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
          home={current}
          placing={placing}
          reachKm={offPlan ? maxRideKm(0, budget, { curves }) : null}
          onPlace={(at) => {
            setPicked({ ...current, rideTo: at });
            setPlacing(false);
          }}
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
