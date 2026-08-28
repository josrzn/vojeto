import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Plan, PlanDestination } from "../../src/build/buildPlan.js";
import { MapView } from "./MapView.js";
import type { LoadedProfile } from "./grade.js";
import {
  TOURING_CURVES,
  curveFromLinearModel,
  describeCurve,
  type SpeedCurve,
  type SpeedCurves,
} from "../../src/bike/speed.js";
import { toGpx, describeRide, slug } from "../../src/bike/gpx.js";
import { sampleDates } from "../../src/build/dates.js";
import { TripDetail } from "./TripDetail.js";
import { SettingsPanel } from "./SettingsPanel.js";
import { HomePicker } from "./HomePicker.js";
import { Timetable } from "./timetableClient.js";
import type { Loaded, Station } from "./timetableService.js";
import { explore, quickestTrains, type Home } from "./explore.js";
import type { Itinerary } from "../../src/shared/types.js";
import { warmCache, withVariant, type Rides } from "./rides.js";
import { routeRide } from "./routeHome.js";
import type { BikeTrack } from "../../src/bike/track.js";
import { preferred, stylesFrom, type RouteStyle } from "./routeStyles.js";
import { profileFromPoints } from "./rideProfile.js";
import {
  budgetOf,
  circleKm,
  homeFromPlan,
  mergeSettings,
  queryFor,
  readRecentHome,
  rememberHome,
  rememberSettings,
  settingsFromPlan,
  SETTINGS_KEY,
  type Settings,
} from "./settings.js";
import { judge } from "./budget.js";
import { bestVariant, formatHours, formatMinutes, groupIntoCorridors } from "./corridors.js";

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
 * Where the browser routes when no plan says otherwise.
 *
 * The public instance, the same one `npm run plan` defaults to. It is donated
 * hardware, which is why a route is asked for when you point at a station and
 * not before.
 */
const BROUTER_FALLBACK = "https://brouter.de/brouter";

/** A ride being fetched: which station, which way home. */
interface Routing {
  stationId: string;
  styleId: string;
}

export function App() {
  // The timetable is the app. A plan is an optional head start.
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [stations, setStations] = useState<Station[] | null>(null);
  const [timetableError, setTimetableError] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const timetable = useRef<Timetable | null>(null);

  const [storedSettings, setStoredSettings] = useState<unknown>(() => readJson(SETTINGS_KEY));
  const [picked, setPicked] = useState<Home | null>(readRecentHome);

  const [monthKey, setMonthKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [openCorridors, setOpenCorridors] = useState<Set<string>>(new Set());
  const [showField, setShowField] = useState(true);
  const [showNoTrain, setShowNoTrain] = useState(false);
  const [showFrontier, setShowFrontier] = useState(false);
  const [showMisses, setShowMisses] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useRemembered("vojeto.sidebar", true);
  const [keyOpen, setKeyOpen] = useRemembered("vojeto.key", true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [homeOpen, setHomeOpen] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const [itineraries, setItineraries] = useState<Itinerary[]>([]);
  const [querying, setQuerying] = useState(false);
  const [rides, setRides] = useState<Rides>({});
  const [profiles, setProfiles] = useState<Record<string, LoadedProfile>>({});
  const [routing, setRouting] = useState<Routing | null>(null);
  const [rideError, setRideError] = useState<string | null>(null);
  const tracks = useRef(new Map<string, BikeTrack>());
  const routeRun = useRef<AbortController | null>(null);
  const selectedRow = useRef<HTMLLIElement | null>(null);

  // Both loads start at once and neither blocks the other: the timetable is
  // what the page needs, the plan is what it would like.
  useEffect(() => {
    let cancelled = false;
    const client = new Timetable();
    timetable.current = client;
    client
      .load()
      .then((it) => {
        if (cancelled) return;
        setLoaded(it);
        setStations(it.stations);
      })
      .catch((error: unknown) => {
        if (!cancelled) setTimetableError(message(error));
      });

    fetch("./data/plan.json")
      .then((response) => (response.ok ? (response.json() as Promise<Plan>) : null))
      .then((it) => {
        if (!cancelled && it) setPlan(it);
      })
      .catch(() => {
        // No plan is the ordinary case for a fresh checkout, and nothing here
        // needs one. Silence is the right amount of noise about it.
      });

    return () => {
      cancelled = true;
      client.terminate();
    };
  }, []);

  // The settings on screen: what you chose, over what the plan was built with,
  // over the defaults. Held this way rather than as a copy taken on the first
  // render — there is nothing to copy before the plan has loaded, and a copy
  // would never catch up.
  const settings = useMemo(
    () => mergeSettings(settingsFromPlan(plan), storedSettings),
    [plan, storedSettings],
  );
  const chooseSettings = (next: Settings) => {
    setStoredSettings(next);
    rememberSettings(next);
  };

  const curves = useMemo((): SpeedCurves => {
    // A plan.json built before speed became a curve carries the two scalars it
    // used instead; read them rather than crash, so the page shows the numbers
    // that plan was actually built with until it is rebuilt.
    const s = plan?.settings as
      | Partial<{ speedByGradient: SpeedCurves | SpeedCurve; speedKmh: number; climbMetresPerHour: number }>
      | undefined;
    if (!s) return TOURING_CURVES;
    const shipped = s.speedByGradient;
    if (!shipped) {
      return everySurface(curveFromLinearModel(s.speedKmh ?? 16, s.climbMetresPerHour ?? 600));
    }
    return Array.isArray(shipped) ? everySurface(shipped as SpeedCurve) : (shipped as SpeedCurves);
  }, [plan]);

  const effort = useMemo(() => ({ curves }), [curves]);
  const budget = useMemo(() => budgetOf(settings), [settings]);
  const radiusKm = useMemo(() => circleKm(settings, effort), [settings, effort]);
  const styles = useMemo(() => stylesFrom(plan), [plan]);
  const style = preferred(styles, settings.style);
  const brouterUrl = plan?.settings.brouterUrl || BROUTER_FALLBACK;

  // Where you are starting from and finishing: the last pair you asked about,
  // or the one a plan was built for. Never a place written into the code.
  const home = picked ?? homeFromPlan(plan);
  const pickHome = (next: Home) => {
    setPicked(next);
    rememberHome(next);
    setSelected(null);
    setPlacing(false);
  };

  const months = useMemo(
    () => (loaded ? sampleDates(loaded.feedStart, loaded.plannableEnd, settings.dayType) : []),
    [loaded, settings.dayType],
  );
  const month = months.find((m) => m.key === monthKey) ?? months[0] ?? null;

  // Ways home already known: a plan built for this very pair, or nothing.
  // Rebuilt from scratch whenever the pair changes, because every ride in it
  // was measured to a door that has just moved.
  const homeKey = home ? `${home.stationId}|${home.rideTo.lat}|${home.rideTo.lon}` : "";
  useEffect(() => {
    routeRun.current?.abort();
    tracks.current.clear();
    setRides(warmCache(plan, home));
    setProfiles({});
    setRouting(null);
    setRideError(null);
    // `home` is rebuilt each render; the identity that matters is the pair's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, homeKey]);

  // Everywhere the train gets you in time. Asked of the worker, which answers in
  // a few milliseconds; the circle is applied to the answer rather than being
  // part of the question, so moving the radius costs nothing at all.
  useEffect(() => {
    const client = timetable.current;
    if (!client || !home || !month || !loaded) return;

    let cancelled = false;
    setQuerying(true);
    client
      .reachable(queryFor(home, month.date, settings))
      .then((found) => {
        if (cancelled) return;
        setItineraries(found);
        setQuerying(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setTimetableError(message(error));
        setQuerying(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, homeKey, month?.date, settings.arriveBy, settings.arriveNoEarlierThan,
      settings.earliestDeparture, settings.maxTravelMinutes, settings.maxTransfers,
      settings.minTransferMinutes, settings.maxTransferMinutes]);

  // The circle, applied. Pure arithmetic over an answer already in hand, so the
  // list and the map follow the radius slider as it moves.
  const { destinations, outside } = useMemo(
    () =>
      home
        ? explore(itineraries, home.rideTo, radiusKm)
        : { destinations: [], outside: [] },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itineraries, home?.rideTo.lat, home?.rideTo.lon, radiusKm],
  );

  const trainHours = useMemo(() => quickestTrains(destinations), [destinations]);

  /**
   * Fetches one way home from one station.
   *
   * The whole of the app's talking to BRouter, and it happens because you
   * pointed at something. Aborted when the door moves: a route to a doorway you
   * have left is not worth waiting for.
   */
  const route = useCallback(
    (destination: PlanDestination, wanted: RouteStyle) => {
      if (!home) return;
      // Whatever was in flight was for a station you have moved on from.
      routeRun.current?.abort();
      const run = new AbortController();
      routeRun.current = run;
      setRouting({ stationId: destination.stationId, styleId: wanted.id });
      setRideError(null);

      void routeRide(
        {
          from: { lat: destination.lat, lon: destination.lon },
          rideTo: home.rideTo,
          style: wanted,
          trainHours: trainHours[destination.stationId] ?? destination.travelMinutes / 60,
        },
        {
          baseUrl: brouterUrl,
          effort,
          budget,
          trainHours: 0,
          profileStepMetres: 100,
        },
        run.signal,
      )
        .then((routed) => {
          if (run.signal.aborted) return;
          tracks.current.set(`${destination.stationId}|${wanted.id}`, routed.track);
          setProfiles((all) => ({
            ...all,
            [`${destination.stationId}|${wanted.id}`]: routed.profile,
          }));
          setRides((all) => withVariant(all, destination.stationId, routed.variant));
          setRouting(null);
        })
        .catch((error: unknown) => {
          if (run.signal.aborted) return;
          setRideError(`${wanted.label}: ${message(error)}`);
          setRouting(null);
        });
    },
    [home, trainHours, brouterUrl, effort, budget],
  );

  const chosen = destinations.find((d) => d.stationId === selected) ?? null;

  // Pointing at a station is the whole request: one route, the preferred way
  // home, and nothing else until you ask for more.
  useEffect(() => {
    if (!chosen) return;
    if (rides[chosen.stationId]?.some((v) => v.id === style.id)) return;
    route(chosen, style);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen?.stationId, style.id]);

  // Memoised because the map reads the variant objects by identity: rebuilding
  // them on every render would have it re-frame the ride every time anything at
  // all changed on screen.
  const judged = useMemo(
    () =>
      chosen
        ? judge(
            rides[chosen.stationId] ?? [],
            trainHours[chosen.stationId] ?? chosen.travelMinutes / 60,
            budget,
          )
        : null,
    [chosen, rides, trainHours, budget],
  );
  const variants = judged?.variants ?? [];
  const active = variants.find((v) => v.id === variantId) ?? bestVariant(variants) ?? null;

  const remaining = styles.filter((s) => !variants.some((v) => v.id === s.id));
  const routeMore = (wanted: RouteStyle) => {
    if (chosen && !routing) route(chosen, wanted);
  };

  // The chart for the ride on screen: made here when the ride was routed here,
  // fetched when it came out of a plan, which writes profiles to disk.
  const profileKey = chosen && active ? `${chosen.stationId}|${active.id}` : null;
  const profile = profileKey ? (profiles[profileKey] ?? null) : null;
  const elevationFile = active?.elevationFile ?? null;

  useEffect(() => {
    if (!profileKey || !elevationFile || profiles[profileKey]) return;
    let cancelled = false;
    void fetch(`./data/profiles/${elevationFile}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((raw: { points: number[][]; surfaces?: number[] }) => {
        if (cancelled) return;
        setProfiles((all) => ({ ...all, [profileKey]: profileFromPoints(raw.points, raw.surfaces) }));
      })
      .catch(() => {
        // The plan's profile directory is optional; the ride is still shown.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey, elevationFile]);

  // A ride routed here has no file to download, so the .gpx is built in the
  // page from the track it was routed with and handed over as a blob.
  const [gpxUrl, setGpxUrl] = useState<string | null>(null);
  useEffect(() => {
    const track = profileKey ? tracks.current.get(profileKey) : null;
    if (!track || !chosen || !active || !home) {
      setGpxUrl(null);
      return;
    }
    const xml = toGpx({
      name: `${chosen.name} → ${home.name}`,
      description: describeRide(active),
      coordinates: track.coordinates,
    });
    const url = URL.createObjectURL(new Blob([xml], { type: "application/gpx+xml" }));
    setGpxUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [profileKey, chosen, active, home]);

  const corridors = useMemo(() => groupIntoCorridors(destinations, rides), [destinations, rides]);

  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  useEffect(() => {
    if (selected && !destinations.some((d) => d.stationId === selected)) setSelected(null);
  }, [destinations, selected]);

  if (timetableError && !loaded) {
    return (
      <div className="splash">
        <h1>No timetable yet</h1>
        <p className="splash-detail">{timetableError}</p>
        <p>
          Build one with <code>npm run ingest</code>.
        </p>
      </div>
    );
  }

  if (!loaded) return <div className="splash">Reading the timetable…</div>;

  const stationCount = destinations.length;
  const gpxName = chosen && active ? `${slug(chosen.name)}-${slug(active.id)}.gpx` : "ride.gpx";

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
              title="The station you leave from and the door you ride back to"
            >
              {home ? `${home.name} → home` : "Choose where you live"}
            </button>
            <button
              type="button"
              className="settings-open"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              title="Your trains, your day, how far to look"
            >
              Settings
            </button>
          </span>
          {home ? (
            <p>
              From <strong>{home.name}</strong>, off the train by{" "}
              <strong>{settings.arriveBy}</strong>, home within{" "}
              <strong>{formatHours(settings.budgetHours)}</strong>
              {settings.maxDays > 1 && ` over up to ${settings.maxDays} days`}. Looking{" "}
              <strong>{radiusKm} km</strong> around the door.
            </p>
          ) : (
            <p>
              Pick the station you would catch the train at, and drop a pin where
              the ride has to end. Everything else follows from those two.
            </p>
          )}
        </header>

        {months.length > 0 && (
          <nav className="months" aria-label="Month">
            {months.map((m) => (
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
        )}

        {/* One scrolling region for everything the settings change, so a tall
            panel pushes the list down rather than off the bottom of the screen
            where nobody can see it react. */}
        <div className="sidebar-body">
          {(homeOpen || !home) && (
            <HomePicker
              stations={stations}
              loading={stations === null && timetableError === null}
              error={timetableError}
              home={home}
              placing={placing}
              onPick={pickHome}
              onPlace={setPlacing}
              onClose={() => {
                setHomeOpen(false);
                setPlacing(false);
              }}
            />
          )}

          {settingsOpen && (
            <SettingsPanel
              settings={settings}
              radiusKm={radiusKm}
              curves={curves}
              counts={{ inside: destinations.length, beyond: outside.length, querying }}
              styles={styles}
              onChange={chooseSettings}
              onClose={() => setSettingsOpen(false)}
            />
          )}

          {home && month && (
            <p className="month-note">
              {querying
                ? "Asking the timetable…"
                : `${month.label} · ${stationCount} station${stationCount === 1 ? "" : "s"} inside ${radiusKm} km` +
                  (outside.length > 0 ? `, ${outside.length} beyond` : "")}
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
                      {formatMinutes(corridor.quickestTrainMinutes)}–
                      {formatMinutes(corridor.slowestTrainMinutes)} out
                    </span>
                  </button>

                  {(isOpen || holdsSelection) && (
                    <ul className="results">
                      {corridor.destinations.map((destination) => {
                        const ride = bestVariant(rides[destination.stationId]);
                        const isSelected = destination.stationId === selected;
                        return (
                          <li key={destination.stationId} ref={isSelected ? selectedRow : null}>
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
                              {ride ? (
                                <span
                                  className={ride.feasible ? "result-ride" : "result-ride is-over"}
                                  title={ride.feasible ? undefined : "Longer than the day allows"}
                                >
                                  🚲 {Math.round(ride.km)} km · +{ride.ascentMetres} m ·{" "}
                                  {formatHours(ride.hours)}
                                  {ride.days > 1 && ` · ${ride.days} days`}
                                </span>
                              ) : (
                                routing?.stationId === destination.stationId && (
                                  <span className="result-ride">🚲 finding the way home…</span>
                                )
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
            {home && !querying && corridors.length === 0 && (
              <li className="empty">
                No train gets you anywhere inside {radiusKm} km by {settings.arriveBy}. Try a
                later arrival, another change, or a wider circle.
              </li>
            )}
          </ul>

          {outside.length > 0 && (
            <div className="misses">
              <button
                type="button"
                className="misses-head"
                onClick={() => setShowMisses((v) => !v)}
                aria-expanded={showMisses}
              >
                {showMisses ? "▾" : "▸"} {outside.length} beyond the {radiusKm} km circle
              </button>
              {showMisses && (
                <>
                  <ul className="miss-list">
                    {outside.slice(0, 8).map((miss) => (
                      <li key={miss.stationId}>
                        <span className="miss-name">{miss.name}</span>
                        <span className="miss-figures">
                          {formatMinutes(miss.travelMinutes)} on the train
                        </span>
                        <span className="miss-need">{Math.round(miss.km)} km out</span>
                      </li>
                    ))}
                  </ul>
                  {outside[0] && (
                    <button
                      type="button"
                      className="settings-reset"
                      onClick={() =>
                        chooseSettings({ ...settings, radiusKm: Math.ceil(outside[0]!.km / 10) * 10 })
                      }
                    >
                      Widen to {Math.ceil(outside[0].km / 10) * 10} km, for {outside[0].name}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <footer className="colophon">
          Feed {formatDate(loaded.feedStart)} → {formatDate(loaded.plannableEnd)}. Riding at{" "}
          {describeCurve(curves.paved)}.
          {plan ? " Routes already in the plan are shown without asking BRouter again." : ""}
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
          mapStyleUrl={plan?.settings.mapStyleUrl ?? null}
          field={plan && showField ? plan.field : null}
          fieldLevelsTo={settings.budgetHours}
          noTrain={plan?.noTrain ?? []}
          home={home}
          placing={placing}
          reachKm={home ? radiusKm : null}
          onPlace={(at) => {
            if (home) pickHome({ ...home, rideTo: at });
          }}
          destinations={destinations}
          selected={selected}
          variant={active}
          frontierHours={
            showFrontier && chosen ? settings.budgetHours - chosen.travelMinutes / 60 : null
          }
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
                <span className="swatch swatch-dot" /> station you could be at in time
              </li>
              <li>
                <span className="swatch swatch-dash" /> {radiusKm} km around the door — as far
                as this is looking
              </li>
              {(plan?.noTrain.length ?? 0) > 0 && (
                <li>
                  <label>
                    <input
                      type="checkbox"
                      checked={showNoTrain}
                      onChange={(e) => setShowNoTrain(e.target.checked)}
                    />
                    <span className="swatch swatch-hollow" /> station with no morning train (
                    {plan!.noTrain.length})
                  </label>
                </li>
              )}
              {plan?.field && (
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
              {plan?.field && showField && (
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

          {keyOpen && chosen && active && (
            <p className="key-note">
              <strong>{chosen.name}</strong>: {formatHours(chosen.travelMinutes / 60)} on the
              train leaves {formatHours(settings.budgetHours - chosen.travelMinutes / 60)} for
              riding. This way home is {formatHours(active.hours)}, so it fits with{" "}
              {formatHours(Math.max(0, active.slackHours))} spare.
            </p>
          )}
        </div>

        {chosen && (
          <TripDetail
            destination={chosen}
            variants={variants}
            active={active}
            profile={profile}
            effort={effort}
            gpxUrl={gpxUrl ?? (active?.gpx ? `./data/gpx/${active.gpx}` : null)}
            gpxName={gpxName}
            routing={routing?.stationId === chosen.stationId ? routing.styleId : null}
            error={rideError}
            remaining={remaining}
            tooShort={judged?.tooShort ?? false}
            minHours={settings.minHours}
            onRouteMore={routeMore}
            onHoverProfile={setHoverIndex}
            onPickVariant={setVariantId}
            onClose={() => setSelected(null)}
          />
        )}
      </main>
    </div>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJson(key: string): unknown {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

/** 20260914 → "2026-09-14", for the one place the feed's own dates are shown. */
function formatDate(date: number): string {
  const text = String(date);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}
