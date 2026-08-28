import { useEffect, useMemo, useRef, useState } from "react";
import { searchStations, type Home } from "./explore.js";
import type { Station } from "./timetableService.js";
import type { Point } from "../../src/shared/geo.js";

interface Props {
  /** Every station in the feed, or null while the timetable is still loading. */
  stations: Station[] | null;
  loading: boolean;
  error: string | null;
  /** The pair being asked about, or null until someone picks a station. */
  home: Home | null;
  placing: boolean;
  onPick: (home: Home) => void;
  onPlace: (placing: boolean) => void;
  onClose: () => void;
}

/**
 * The two places the whole app is about.
 *
 * Where you catch the train and where the ride has to end are different places,
 * and the difference matters: on a bad day it is a kilometre of towpath. This
 * is the pair everything else is derived from, which is why it is not filed
 * under settings — it is the question, not a preference about how to answer it.
 *
 * The station list is thousands long, so it is searched rather than scrolled.
 * The finishing point has no list — it is a spot on a map, and the only sane
 * way to give one is to point at it.
 */
export function HomePicker({
  stations,
  loading,
  error,
  home,
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
        {home && (
          <button type="button" className="detail-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        )}
      </header>

      <label className="setting">
        <span className="setting-label">Catch the train at</span>
        <input
          ref={box}
          type="search"
          className="home-search"
          placeholder={
            loading ? "loading the timetable…" : (home?.name ?? "type a station name")
          }
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
                className={station.id === home?.stationId ? "home-match is-current" : "home-match"}
                onClick={() => {
                  const at = { lat: station.lat, lon: station.lon };
                  onPick({
                    stationId: station.id,
                    name: station.name,
                    at,
                    // Until you say otherwise, the ride ends at the station you
                    // leave from. That is a plain fact rather than a guess, and
                    // moving the pin is the next thing this panel offers.
                    rideTo: home?.rideTo ?? at,
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
          <strong>{home ? describe(home.rideTo) : "—"}</strong>
        </span>
        <button
          type="button"
          className={placing ? "home-place is-armed" : "home-place"}
          onClick={() => onPlace(!placing)}
          disabled={!home}
        >
          {placing ? "click the map…" : "move it"}
        </button>
      </p>
      <span className="setting-hint">
        Where the ride actually ends — your door, not the platform.
      </span>
    </section>
  );
}

/** Five decimals is about a metre, which is as exact as pointing at a map gets. */
function describe(point: Point): string {
  return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}
