import type { Query } from "../../src/router/raptor.js";
import type { Itinerary } from "../../src/shared/types.js";
import type { Loaded, Request, Response } from "./timetableService.js";

/**
 * A request before it is given an id.
 *
 * Distributed over the union on purpose: a plain `Omit<Request, "id">` collapses
 * the alternatives into one object with neither `base` nor `query` on it.
 */
type Unsent = Request extends infer T ? (T extends { id: number } ? Omit<T, "id"> : never) : never;

/**
 * The worker, as a promise-returning object.
 *
 * Requests carry an id and replies quote it, so several can be in flight at
 * once and none of them has to be the next one to come back — a query fired
 * while a slider is still moving must not be mistaken for the answer to the
 * one after it.
 */
export class Timetable {
  private worker: Worker;
  private next = 1;
  private waiting = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL("./timetable.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<Response>) => {
      const pending = this.waiting.get(event.data.id);
      if (!pending) return;
      this.waiting.delete(event.data.id);
      if (event.data.ok) pending.resolve(event.data.value as never);
      else pending.reject(new Error(event.data.error));
    };
    // A worker that dies takes every outstanding promise with it; without this
    // they would simply never settle and the page would sit on a spinner.
    this.worker.onerror = (event) => this.failAll(new Error(event.message || "Timetable worker failed"));
  }

  load(base = "./data/"): Promise<Loaded> {
    // Resolved here, on the main thread, because a relative URL inside a worker
    // resolves against the worker script — which Vite serves from /assets/ —
    // and not against the page. Unresolved, the fetch 404s and comes back as
    // the SPA's index.html, which fails as "unexpected token '<'".
    return this.send({ kind: "load", base: new URL(base, location.href).href });
  }

  reachable(query: Query): Promise<Itinerary[]> {
    return this.send({ kind: "reachable", query });
  }

  terminate(): void {
    this.worker.terminate();
    this.failAll(new Error("The timetable worker was stopped"));
  }

  private send<T>(request: Unsent): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (value: never) => void, reject });
      this.worker.postMessage({ ...request, id } as Request);
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.waiting.values()) pending.reject(error);
    this.waiting.clear();
  }
}
