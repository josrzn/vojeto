import { useEffect, useMemo, useRef, useState } from "react";
import { searchStations, type Home } from "./explore.js";
import type { Station } from "./timetableService.js";
import type { Point } from "../../src/shared/geo.js";

interface Props {
  /** Every station in the feed, or null while the timetable is still loading. */
  stations: Station[] | null;
  loading: boolean;
  error: string | null;
  home: Home;
  /** The home the plan was built for, which is the one with rides in it. */
  built: Home;
  placing: boolean;
  onPick: (home: Home) => void;
  onPlace: (placing: boolean) => void;
  onClose: () => void;
}

/**
 * Choosing where you are starting from, and where the ride has to end.
 *
 * These are two different places and the difference matters: you catch the
 * train at the station and you stop riding at your door, which on a bad day is
 * a kilometre of towpath apart. The planner has always kept them separate; this
 * is that pair made editable.
 *
 * The station list is 2,497 long, so it is searched rather than scrolled. The
 * ride-to point has no list — it is a spot on a map, and the only sane way to
 * give one is to point at it.
 */
export function HomePicker({
  stations,
  loading,
  error,
  home,
  built,
  placing,
  onPick,
  onPlace,
  onClose,
}: Props) {
  const [search, setSearch] = useState("");
  const box = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    box.current?.focus();
  }, [stations]);

  const matches = useMemo(
    () => (stations ? searchStations(stations, search, 30) : []),
    [stations, search],
  );

  return (
    <section className="home-picker" aria-label="Where you start and finish">
      <header className="settings-head">
        <h3>Start and finish</h3>
        <button type="button" className="detail-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <label className="setting">
        <span className="setting-label">Catch the train at</span>
        <input
          ref={box}
          type="search"
          className="home-search"
          placeholder={loading ? "loading the timetable…" : home.name}
          value={search}
          disabled={loading || !stations}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>

      {error && <p className="home-error">{error}</p>}

      {search.trim() !== "" && stations && (
        <ul className="home-matches">
          {matches.map((station) => (
            <li key={station.id}>
              <button
                type="button"
                className={station.id === home.stationId ? "home-match is-current" : "home-match"}
                onClick={() => {
                  onPick({
                    ...home,
                    stationId: station.id,
                    name: station.name,
                    at: { lat: station.lat, lon: station.lon },
                  });
                  setSearch("");
                }}
              >
                {station.name}
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="empty">No station by that name.</li>}
        </ul>
      )}

      <p className="home-rideto">
        <span className="setting-label">
          Ride home to
          <strong>{describe(home.rideTo)}</strong>
        </span>
        <button
          type="button"
          className={placing ? "home-place is-armed" : "home-place"}
          onClick={() => onPlace(!placing)}
        >
          {placing ? "click the map…" : "move it"}
        </button>
      </p>
      <span className="setting-hint">
        Where the ride actually ends — your door, not the platform.
      </span>

      <button
        type="button"
        className="settings-reset"
        onClick={() => onPick(built)}
        disabled={home.stationId === built.stationId && describe(home.rideTo) === describe(built.rideTo)}
      >
        Back to {built.name}
      </button>
    </section>
  );
}

/** Five decimals is about a metre, which is as exact as pointing at a map gets. */
function describe(point: Point): string {
  return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}
