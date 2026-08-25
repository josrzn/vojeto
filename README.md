# vojeto

Take the train out in the morning, ride the bike home.

Given a home station, this works out every station you can reach by TER in time
to be off the train by a set hour, for one sample date per month the SNCF feed
covers, and plans a cycling route back from each. The result is a static site:
pick a month, scan the list, click a station to see the trains out and the ride
home.

![The planner](docs/screenshot.png)

<sub>Captured without network access to the tile host, so the map falls back to a
plain background — with tiles you get a normal map underneath.</sub>

## Quick start

```sh
npm install
npm run ingest      # download the SNCF feed and check it against your config
npm run plan        # build public/data/plan.json
npm run dev         # http://localhost:5173
```

`ingest` is worth running on its own the first time: it prints which routes the
filter kept, which station your home resolved to, and which dates it will plan
for. `plan` then does the real work — expect it to take a few minutes, most of
it waiting on BRouter.

## Configuration

Everything personal lives in [`config/home.json`](config/home.json).

| Key | Meaning |
| --- | --- |
| `home.query` | Station name to depart from. Set `home.stopId` instead if the name is ambiguous — `npm run stations -- <name>` lists candidates. |
| `trip.arriveBy` | Be off the train by this time. |
| `trip.arriveNoEarlierThan` | Arriving before this is pointless, so those trains are ignored. |
| `trip.maxTravelMinutes` | Longest acceptable journey out. |
| `trip.maxTransfers` | 0 for direct trains only. |
| `bike.kmPerDay` | How far you actually want to ride in a day; sets where overnight stops fall. |
| `bike.maxTotalKm` | Rides longer than this as the crow flies are not attempted. |
| `bike.brouterUrl` | Point at `http://localhost:17777/brouter` to use your own BRouter. |
| `gtfs.keepRouteTypes` | Optional. Restrict to specific `route_type` values (e.g. `[106]` for regional rail) instead of matching on names. |
| `dayType` | `saturday`, `sunday` or `weekday` — which day each month's sample date lands on. |

### Moving house

Change `home.query`, re-run `npm run plan`. Nothing else is home-specific.

## What the numbers mean, and what they don't

**The feed only reaches about five months ahead.** SNCF publishes roughly 151
days of timetable, so "vary the month" means the next four or five months, not
next July. `npm run ingest` prints the exact window. Re-run `plan` monthly and
the horizon rolls forward.

**One sample date per month.** The plan uses the second Saturday of each month
(or whatever `dayType` says). TER timetables shift a little through the year and
a lot on public holidays, so treat a listed train as "this service normally
runs", not as a booking.

**Bikes on trains are not in the data.** GTFS says nothing about bike spaces.
The route filter keeps TER, where a non-folded bike normally travels free and
unreserved subject to space — but that is a rule of thumb, not a guarantee, and
it is why TGV and Intercités are filtered out by default: both require a paid
reservation for a bike. Check before you rely on a specific train.

**The ride home is a suggestion.** BRouter's `trekking` profile prefers quiet
roads and cycle paths, but it does not know about seasonal closures, gravel, or
what you find pleasant. Distances and ascent come from BRouter; the day splits
are just the total divided evenly, tagged with the nearest station in case you
want to stop early and take the train the rest of the way.

## Checking the route filter

This is the one part that depends on how SNCF labels things this month, so it
is the first place to look if the numbers seem wrong.

```sh
npm run ingest -- --explain-routes
```

It reports how many routes were read, breaks them down by `route_type` with a
rail/not-rail verdict, and lists the kept and dropped labels. **If nothing
matches, `ingest` prints that same report automatically** — you never need a
second run to find out why.

Two ways to fix a mismatch:

- **By name** — `gtfs.keepRoutePatterns` and `gtfs.dropRoutePatterns` are
  case-insensitive regular expressions, matched against
  `agency | short name | long name | description` (exactly the labels the
  report lists). An empty `keepRoutePatterns` means "keep every rail route".
- **By type** — set `gtfs.keepRouteTypes` to the `route_type` values you want,
  taken from the report's breakdown. This bypasses name matching entirely, and
  is the more stable option if the labels turn out to be inconsistent.

Note that rail covers both `route_type` 2 and the extended range 100–117
(102 is long distance, 106 regional), because feeds use both.

## Commands

```sh
npm run ingest                 # download + validate
npm run plan                   # build the plan
npm run stations -- Lyon       # search station names
npm test                       # unit tests
npm run build                  # typecheck + build the static site into dist/
```

Useful flags (after `--`):

| Flag | Effect |
| --- | --- |
| `--feed <path>` | Use a local `.zip` or extracted directory instead of downloading. |
| `--explain-routes` | List every route label and whether the filter kept it. |
| `--skip-bike` | Train results only, no BRouter calls. Fast. |
| `--limit <n>` | Only route the `n` nearest destinations home. |
| `--brouter <url>` | Route against a different BRouter instance. |
| `--max-age-hours <n>` | Re-download the feed if the cached copy is older than this. |

## How it works

| Path | Role |
| --- | --- |
| `src/gtfs/` | Download the feed, stream-parse the CSV, filter to TER, build a routable index of stop patterns. |
| `src/router/raptor.ts` | RAPTOR. Run once per morning departure from home, keeping the best journey per station that lands inside the arrival window. |
| `src/bike/` | BRouter client (disk-cached) and the ride-home planner: day splits, ascent, bail-out stations. |
| `src/build/` | Pick a date per month, run both halves, emit `public/data/plan.json`. |
| `web/` | React + MapLibre front end. Reads only `plan.json`, so the built site is fully static. |

The generated `plan.json` is the entire contract between the two halves — the
web app never talks to SNCF or BRouter, so `dist/` can be hosted anywhere.

### Working offline

`scripts/fake-brouter.ts` serves plausible fake routes, for developing the UI
without touching the real service:

```sh
npx tsx scripts/fake-brouter.ts 17777
npm run plan -- --brouter http://127.0.0.1:17777/brouter
```

If the map style host is unreachable, the map falls back to a plain background
and still plots stations and routes.

## Data

- Timetables: [Réseau SNCF TGV, Intercités et TER](https://transport.data.gouv.fr/datasets/horaires-sncf) via transport.data.gouv.fr (ODbL).
- Cycling routes: [BRouter](https://brouter.de/), over OpenStreetMap data.
- Map tiles: [OpenFreeMap](https://openfreemap.org/).

Be gentle with the public BRouter instance: every response is cached under
`data/brouter-cache/`, and requests are throttled to one a second. If you plan
to re-run this often, [run your own](https://github.com/abrensch/brouter).
