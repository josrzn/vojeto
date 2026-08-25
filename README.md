# vojeto

Take the train out in the morning, ride the bike home.

Given a home station, this works out every station you can reach by TER in time
to be off the train by a set hour, for one sample date per month the SNCF feed
covers, plans several cycling routes back from each, and keeps the ones whose
**train out plus ride home fits the time you actually have**. The result is a
static site: pick a month, open a line, click a station to compare ways home.

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

`ingest` is worth running on its own the first time: it prints which services the
filter kept, which station your home resolved to, where the ride home ends, and
which dates it will plan for. `plan` then does the real work — one BRouter
request per station per variant, throttled to one a second and cached on disk,
so the first run takes a few minutes and later ones are quick.

## Configuration

Everything personal lives in [`config/home.json`](config/home.json).

### Where you start and where you finish

```json
"home": {
  "station": { "query": "Roanne", "stopId": null },
  "rideTo": "46°02'03.80\"N 4°04'45.63\"E"
}
```

`station` is where you catch the train; `rideTo` is where the ride home ends,
which is usually your door rather than the station. `rideTo` takes decimal
degrees (`46.034389, 4.079342`) or DMS as copied out of a mapping app. Use
`stopId` instead of `query` if the station name is ambiguous —
`npm run stations -- <name>` lists candidates.

### How much time you have

This is the constraint that decides what shows up.

```json
"ride": {
  "budgetHours": 6,
  "maxDays": 1,
  "hoursPerDay": 6,
  "speedKmh": 16,
  "climbMetresPerHour": 600
}
```

A destination is kept only if `train out + ride home` fits `budgetHours`. Riding
time is estimated as `km / speedKmh + ascent / climbMetresPerHour` — the usual
touring rule, so the numbers move predictably when you change the settings.
BRouter's own estimate is shown alongside for comparison but is not used to
decide anything.

For an overnight trip, raise `maxDays`. Day one gets whatever is left of
`budgetHours` after the train; each later day gets `hoursPerDay`. The ride is
then split at those points, and every overnight stop is tagged with the nearest
station in case you want to give up and take the train.

### Ways home

```json
"alternatives": 2,
"variants": [
  { "id": "trekking", "label": "Quiet roads", "profile": "trekking" },
  { "id": "gravel",   "label": "Gravel",      "profile": "gravel"   },
  { "id": "fast",     "label": "Direct",      "profile": "fastbike" }
]
```

Each profile is requested `alternatives` times, using BRouter's
`alternativeidx`, giving up to `profiles x alternatives` ways home per station.
Identical results are dropped, and each is checked against the budget
separately — a gravel route can be too slow for a day when the direct one fits.

`profile` must be a profile the BRouter server actually has. `trekking`,
`fastbike` and `shortest` are always present; **`gravel` and other extras depend
on the server**, so check what yours offers (the profile dropdown at
[brouter.de/brouter-web](https://brouter.de/brouter-web/) lists them). A profile
the server rejects is reported once and skipped — the other routes still build.

### Trains

```json
"trip": {
  "arriveBy": "09:00",
  "arriveNoEarlierThan": "06:30",
  "earliestDeparture": "05:00",
  "maxTravelMinutes": 240,
  "maxTransfers": 0,
  "minTransferMinutes": 5
}
```

`maxTransfers` defaults to `0`, since a bike and a tight connection are a bad
combination. Raising it to 2 roughly quadruples the destinations.

### Moving house

Change `home.station.query` and `home.rideTo`, re-run `npm run plan`. Nothing
else is home-specific.

## What the numbers mean, and what they don't

**The usable horizon is shorter than the feed claims.** The feed declares dates
about five months out, but the timetable is only really populated for the first
three to four. Past that it collapses to one or two stub services a day — a feed
running to 2027-01-31 stopped being useful after 2026-12-12. Planning into that
tail silently returns nothing, so `ingest` measures where the service count
falls off and stops there, reporting both dates:

```
Feed declares 2026-08-24 to 2027-01-31; plannable to 2026-12-12 (5 months)
```

So "vary the month" means the next three or four months, not next July. Re-run
`plan` monthly and the horizon rolls forward.

**One sample date per month.** The plan uses the second Saturday of each month
(or whatever `dayType` says). TER timetables shift a little through the year and
a lot on public holidays, so treat a listed train as "this service normally
runs", not as a booking.

**Bikes on trains are not in the data.** GTFS says nothing about bike spaces.
The filter keeps `OCETrain TER`, where a non-folded bike normally travels free
and unreserved subject to space — but that is a rule of thumb, not a guarantee.
TGV, Intercités and OUIGO are excluded because all three require a paid bike
reservation, and replacement coaches because they will not take a bike at all.
Check before you rely on a specific train.

**The ride home is a suggestion.** BRouter knows the road network, not seasonal
closures, surface condition after rain, or what you find pleasant. Distances and
ascent come from BRouter; the riding time is this project's own estimate, and
the "to spare" figure inherits all of that uncertainty. Treat a route with ten
minutes of slack as a coin flip.

**Stations on one line are a difficulty ladder, not duplicates.** Most of what
comes back from a given home station sits on a handful of lines, and going one
stop further out mostly buys a longer ride over similar ground. The app groups
stations by the line of your final leg for exactly this reason: a corridor
collapses to one row showing the range of rides it offers, and opens into the
stations along it, ordered by ride length. Four lines beat 110 flat rows.

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
| `src/gtfs/` | Download the feed, stream-parse the CSV, filter to TER by stop kind, measure the usable date range, build a routable index of stop patterns. |
| `src/router/raptor.ts` | RAPTOR. Run once per morning departure from home, keeping the best journey per station that lands inside the arrival window. |
| `src/bike/` | BRouter client (disk-cached), the effort model that turns distance and climb into hours, and the ride planner: variants, day splits, bail-out stations. |
| `src/build/` | Pick a date per month, run both halves, keep what fits the budget, emit `public/data/plan.json`. |
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

It varies its output by profile and alternative, so the variant picker has
something to show. The distances are invented — do not read anything into them.

If the map style host is unreachable, the map falls back to a plain background
and still plots stations and routes.

## Data

- Timetables: [Réseau SNCF TGV, Intercités et TER](https://transport.data.gouv.fr/datasets/horaires-sncf) via transport.data.gouv.fr (ODbL).
- Cycling routes: [BRouter](https://brouter.de/), over OpenStreetMap data.
- Map tiles: [OpenFreeMap](https://openfreemap.org/).

Be gentle with the public BRouter instance: every response is cached under
`data/brouter-cache/`, and requests are throttled to one a second. If you plan
to re-run this often, [run your own](https://github.com/abrensch/brouter).
