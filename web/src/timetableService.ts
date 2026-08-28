import { unpackTimetable, type PackedTimetable } from "../../src/gtfs/pack.js";
import { reachableStations, type Query } from "../../src/router/raptor.js";
import type { Itinerary, TimetableIndex } from "../../src/shared/types.js";

/**
 * The timetable, answering questions.
 *
 * Kept apart from the worker that hosts it so it can be exercised without one:
 * a Worker needs a browser, a module graph and a message loop, none of which
 * have anything to do with whether a query returns the right trains. The worker
 * file is a dozen lines of plumbing around this.
 */
export interface Loaded {
  stations: Station[];
  feedStart: number;
  plannableEnd: number;
  stops: number;
  patterns: number;
  trips: number;
}

/** A place you can start from: one entry per station, not per platform. */
export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export type Request =
  | { id: number; kind: "load"; base: string }
  | { id: number; kind: "reachable"; query: Query };

export type Response =
  | { id: number; ok: true; value: Loaded | Itinerary[] }
  | { id: number; ok: false; error: string };

export class TimetableService {
  private index: TimetableIndex | null = null;

  /**
   * Fetches and unpacks the two files `npm run ingest` wrote.
   *
   * Both are fetched at once: they are independent, and the structure is the
   * slower of the two to arrive and the slower to parse, so waiting for one
   * before asking for the other would add its latency to the other's.
   */
  async load(base: string, fetcher: typeof fetch = fetch): Promise<Loaded> {
    const [meta, times] = await Promise.all([
      get(fetcher, `${base}timetable.json`, (r) => r.json() as Promise<PackedTimetable>),
      get(fetcher, `${base}timetable.times.bin`, async (r) => new Int32Array(await r.arrayBuffer())),
    ]);

    this.index = unpackTimetable(meta, times);
    return {
      stations: this.stations(this.index),
      feedStart: this.index.feedStart,
      plannableEnd: this.index.plannableEnd,
      stops: this.index.stops.length,
      patterns: this.index.patterns.length,
      trips: this.index.patterns.reduce((n, p) => n + p.trips.length, 0),
    };
  }

  reachable(query: Query): Itinerary[] {
    if (!this.index) throw new Error("The timetable has not been loaded yet");
    return reachableStations(this.index, query);
  }

  /** Whether a query can be answered, without throwing to find out. */
  get ready(): boolean {
    return this.index !== null;
  }

  async handle(request: Request): Promise<Response> {
    try {
      const value =
        request.kind === "load"
          ? await this.load(request.base)
          : this.reachable(request.query);
      return { id: request.id, ok: true, value };
    } catch (error) {
      // Errors do not survive structured cloning with their message intact in
      // every browser, so it is flattened here rather than thrown across.
      return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * One entry per station, positioned on its first platform.
   *
   * A station is what you would name when asked where you are leaving from;
   * the stops under it are platforms and directions, which nobody picks
   * between. Ordered by name so a picker can bisect it.
   */
  private stations(index: TimetableIndex): Station[] {
    const out: Station[] = [];
    for (const [id, stopIndices] of index.stopsInStation) {
      const first = index.stops[stopIndices[0]!];
      if (!first) continue;
      out.push({ id, name: first.name, lat: first.lat, lon: first.lon });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "fr") || a.id.localeCompare(b.id));
  }
}

async function get<T>(
  fetcher: typeof fetch,
  url: string,
  read: (response: Response_) => Promise<T>,
): Promise<T> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return read(response);
}

/** The DOM Response, named around this module's own `Response` message type. */
type Response_ = Awaited<ReturnType<typeof fetch>>;
