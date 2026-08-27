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

`npm run plan` writes into `public/`, which `npm run dev` serves live. A built
site only picks it up when it is rebuilt, so `npm run preview` rebuilds first.
The footer shows when the plan you are looking at was generated: if that is
older than your last run, you are looking at a stale page.

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

`minHours` drops the other end: somewhere you could simply have ridden to is not
worth a train ticket. It is judged against the **most direct** way home, since
that is how far the place really is — taking a longer route back does not turn a
short hop into an outing.

Stations that the train reaches but the ride overruns are not silently dropped.
They are listed, with the budget each would need:

```
Just out of reach on a 8 h budget:
  Rive-de-Gier      70 km, 5.9 h riding + 2.2 h train = needs 8.1 h
  Vienne            84 km, 7.2 h riding + 2.3 h train = needs 9.5 h
```

so you can pick `budgetHours` from what it would actually buy you rather than
guessing. The same list appears in the app under "just out of reach".

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

#### What a profile actually is

`profile` is the only thing in the routing request that decides which roads you
get. A BRouter profile is a `.brf` file: a small cost-function program that
scores every OpenStreetMap way from its tags, and the router then looks for the
cheapest line. Broadly:

| Profile | Optimises for | Tends to give you |
| --- | --- | --- |
| `trekking` | a pleasant ride | cycleways and quiet lanes, main roads penalised, motorways forbidden, tracks and gravel allowed but costly, and a detour preferred over a climb |
| `fastbike` | speed on tarmac | smooth surfaces and directness, tolerating busier roads, less willing to go round |
| `shortest` | distance, and nothing else | the least kilometres, however unpleasant |
| `gravel` | unpaved riding | tracks and paths sought out rather than avoided |

That is the shape of them rather than a specification — the profiles are readable
files, and the dropdown at
[brouter.de/brouter-web](https://brouter.de/brouter-web/) both lists what your
server has and lets you inspect one.

`label` is this project's own gloss and means nothing to BRouter; `profile` is
the name sent over the wire. Exported tracks carry both, so a file that says
`via trekking (Quiet roads)` is unambiguous about which is which.

**Not every server has every profile.** `trekking`, `fastbike` and `shortest`
are always present; `gravel` and other extras depend on the instance. A profile
the server rejects is reported once and skipped — the other routes still build.

### Trains

```json
"trip": {
  "arriveBy": "09:00",
  "arriveNoEarlierThan": "06:30",
  "earliestDeparture": "05:00",
  "maxTravelMinutes": 240,
  "maxTransfers": 1,
  "minTransferMinutes": 10,
  "maxTransferMinutes": 30
}
```

Counting changes is not enough — they have to be worth making. A change is only
accepted if the wait falls between `minTransferMinutes` and
`maxTransferMinutes`:

- **Too short** and you are running for it with a bike, and one late train ends
  the day. Ten minutes is the floor by default.
- **Too long** and the connection exists on paper but the trip does not: forty
  minutes on a cold platform at 6am is not an outing you would choose.

This is enforced inside the routing, not filtered afterwards, which matters:
when the quickest pairing has an awkward wait, the router looks for a different
one rather than dropping the destination. From Roanne, Sain-Bel was reached at
06:54 by way of a five minute scramble; under a 10-30 minute window it comes
back as 07:08 -> 08:24 with a comfortable 24 minute change.

Changes also only ever happen **within a single station** — never a cross-town
hop between, say, Lyon Part-Dieu and Lyon Perrache.

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

## How TER is separated from everything else

This is the least obvious part of the feed, and worth understanding before you
change any of it.

`routes.txt` carries **no usable service type**. Every rail route is
`route_type` 2, the agency is `SNCF VOYAGEURS` for almost all of them, and the
names look like `C30` / `Saint-Étienne - Roanne`. The string "TER" does not
appear anywhere. Filtering on names cannot work.

What does work is the **stop point id**, which encodes the service:

```
StopArea:OCE87726802                the station "Roanne"
  StopPoint:OCETrain TER-87726802     TER trains call here
  StopPoint:OCECar TER-87726802       TER replacement coaches call here
  StopPoint:OCEINTERCITES-87726802    Intercités call here
```

Every trip calls exclusively at stop points of a single kind — this holds for
all 43,517 trips in the feed — so filtering stops by kind also selects trips.
`gtfs.keepStopKinds` is that filter, and it defaults to `["OCETrain TER"]`.

That `OCECar TER` line matters: those are **buses replacing trains**, about
5,000 trips. They carry the TER brand, they would pass any name-based filter,
and they will not take your bike.

### When the numbers look wrong

```sh
npm run ingest -- --explain-routes
```

It lists every stop kind with a count, reports how many routes were read, breaks
them down by `route_type` with a rail/not-rail verdict, and lists the kept and
dropped labels. **If the filter leaves nothing, `ingest` prints that report
automatically** — you never need a second run to find out why.

`gtfs.keepRoutePatterns` / `gtfs.dropRoutePatterns` remain as an escape hatch,
but default to empty, because in this feed they have nothing useful to match on.

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

## The map of what is possible

Trains and bikes distort geography in opposite ways, and the map can show it.

```sh
npm run plan -- --field
```

This samples ride-time-home on a grid and draws it as contours under the
stations. The rings are smooth and roughly centred on home, squashed where the
hills are; the stations sit in a couple of thin lines, because that is where the
railway happens to go.

The two layers are deliberately **not** the same kind of thing. **The rings are
continuous** — you can ride home from any point, so ride time is a real field
over the ground. **The stations are discrete** — you cannot be dropped anywhere
but a station, so they are dots and never a shaded region. Drawing train reach
as a field would suggest you could start anywhere inside it, which is false.

Stations no morning train reaches are drawn hollow, and can be switched on in
the legend. This is the most direct answer to "why can't I get to X": Moulins
sits well inside the riding contours, so the bike was never the obstacle — it
simply has no morning train from Roanne.

The list on the left and the key at bottom right both collapse, and remember it
between visits — the map is usually what you want the room for. Selecting a
station on the map scrolls the list to it.

Selecting a station also draws the train out (through the stops it calls at —
the feed ships no `shapes.txt`, so this is not the track alignment), the ride
home, and optionally a dashed contour at `budgetHours - train time`.

A healthy field gives closed, nested rings. **Broken arcs mean holes**: a sample
the router refused excludes every cell touching it. `plan` reports the three
counts separately and warns when failures are high enough to show.

Sampling costs one request per grid point — about 200 for a 20 km grid over a
160 km radius, cached afterwards. `ride.field.spacingKm` trades detail against
requests, and the cost grows with its square.

## Reading the climbing

Selecting a ride draws an elevation profile in the trip panel and shades the
route on the map by gradient, from the same data and the same scale. Hovering
the profile marks that point on the map.

Gradient is banded — flat or downhill, 1–3%, 3–6%, 6–9%, 9%+ — on a single-hue
ordinal ramp, light to dark, so steepness reads as depth of colour rather than a
change of hue. Flat and downhill take a recessive grey: climbing is what costs
you. Every band is labelled, so nothing rests on colour alone.

The band colours the **area**, not just the line. The area is the largest thing
on screen, so it has to be the channel that encodes gradient; a flat wash under
a thin coloured line makes an easy ride look uniformly hard.

Bands describe a stretch of road rather than a single sample. The gradient is
averaged over several samples before banding and short runs are merged away,
because banding the raw hundred-metre gradient produces stripes wherever it
brushes a threshold — noise, not information, across ground that rides as one
continuous slope. The hover readout still shows the unsmoothed figure.

The map splits warm from cool: **the bike is red** (the ride, and the gradient
ramp that shades it) and **the train is blue**. Stations are green; home is
plain ink, being an anchor rather than a series.

Two things the numbers cannot do:

- The elevations come from a roughly 30 m model. The series is smoothed before
  gradients are taken, so a short sharp pitch may read gentler than it rides.
- Gradients are measured over an even `ride.profileStepMetres` (100 m by
  default), not between the router's own points, which are spaced by OSM nodes
  and would each cover a different distance.

### Distance or time along the bottom

The chart plots against distance by default. The `time` switch above it replots
the same ride against riding time instead, using the same model as every other
duration in the app: `ride.effort.speedKmh` for the distance, plus
`ride.effort.climbMetresPerHour` for whatever the segment climbs.

The point of it is that a climb's *width* becomes its duration. On a distance
axis a 3 km wall and 3 km of valley floor take the same width while costing very
different amounts of the day; on a time axis climbs stretch, descents compress,
and the shape of the chart is the shape of the effort. Faint dashed hour lines
give you something to measure against.

It is a second reading of one ride, not a second opinion. The axis is scaled to
end exactly on the duration shown above it: the profile is resampled and
smoothed, so it accumulates slightly less ascent than the full-resolution track
the stated figure comes from, and an axis ending somewhere the panel contradicts
would be worse than a scaled one. Descents cost their distance and nothing more
— the model has no notion of gaining time downhill, which is roughly true of
a loaded touring bike and not at all true of a racer.

Profiles are written to `public/data/profiles/`, one small file per ride
(~10 KB), fetched only when you look at that ride.

## Taking a route with you

Every routed ride gets a GPX in `public/data/gpx/`, linked from the trip panel —
including rides that overrun the budget, since the route exists and you may want
it for a longer day.

These come from the router's **untouched** track: every point it returned, with
elevation. The line on the map is a different thing, simplified and stripped of
elevation, because a map wants few points and a device at a junction wants all
of them.

One further step is applied on the way out. BRouter emits one point per OSM
node, so a straight rural road can run a kilometre between two of them: correct,
but importers that map-match a track to their own network have nothing to match
over such a gap and report the stretch as leaving known ways. Exports are
densified so no step exceeds `ride.gpx.maxPointSpacingMetres` (50 m by default,
0 to disable). On a 102 km route that took the longest step from 1226 m to 50 m
and left the length unchanged to within 10 m.

That will not help where the route genuinely uses a way the importer lacks. The
`trekking` profile is happy on tracks and paths a road-biased network may not
carry. If an importer still objects, letting it snap the route to its own
network is the reasonable answer.

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
| `--field` | Also sample ride time home on a grid, for the contour backdrop. |
| `--limit <n>` | Only route the `n` nearest destinations home. |
| `--brouter <url>` | Route against a different BRouter instance. |
| `--max-age-hours <n>` | Re-download the feed if the cached copy is older than this. |

## How it works

| Path | Role |
| --- | --- |
| `src/gtfs/` | Download the feed, stream-parse the CSV, filter to TER by stop kind, measure the usable date range, build a routable index of stop patterns. |
| `src/router/raptor.ts` | RAPTOR. Run once per morning departure from home, keeping the best journey per station that lands inside the arrival window. |
| `src/bike/` | BRouter client (disk-cached), the effort model that turns distance and climb into hours, the ride planner (variants, day splits, bail-out stations), and the ride-time field with its marching-squares contours. |
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
