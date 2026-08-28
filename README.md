# vojeto

Take the train out in the morning, ride the bike home.

Pick the station you would catch the train at and drop a pin where the ride has
to end. The app draws a circle around the pin, shows every station a regional
train reaches in time to be off the train by a set hour, and — when you click one — asks
BRouter for a way home and tells you whether **train out plus ride home fits the
time you actually have**.

Both places are yours to change at any moment; everything else follows from
them. There is no home town written into the code.

![The planner](docs/screenshot.png)

<sub>Captured without network access to the tile host, so the map falls back to a
plain background — with tiles you get a normal map underneath.</sub>

## Quick start

```sh
npm install
npm run ingest      # download the SNCF feed and pack it for the browser
npm run dev         # http://localhost:5173
```

That is the whole app. `ingest` writes `public/data/timetable.json` and
`timetable.times.bin` — the feed as a compact index the browser reads in a
worker — and the page does the rest: RAPTOR queries here, BRouter routes on
demand, one request per station you actually point at.

`ingest` is worth reading the first time: it prints which services the filter
kept, which station your home resolved to, where the ride home ends, and which
dates it can plan for.

```sh
npm run plan        # optional: pre-route every station overnight
```

`plan` is a **warm cache**, not a step. It routes every ride home for the pair
in `config/home.json`, writes `public/data/plan.json` with .gpx files and
elevation profiles beside it, and the page then starts with those answers
already filled in instead of asking BRouter as you click. Built for a different
station or a different door, it is about different roads and is ignored. Delete
it and nothing breaks.

`npm run dev` serves `public/` live; a built site only picks up new data when it
is rebuilt, so `npm run preview` rebuilds first.

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
  "budgetHours": 10,
  "maxDays": 1,
  "hoursPerDay": 6,
  "speedByGradient": [
    [-20, 20], [-14, 27], [-9, 31], [-6, 32], [-4, 30], [-2, 24], [-1, 20],
    [0, 16],
    [1, 13], [2, 11], [3, 9.5], [4, 8.6], [5, 8], [6, 7],
    [8, 5.3], [10, 4.3], [12, 3.7], [15, 3.3], [20, 2.8]
  ]
}
```

A destination is kept only if `train out + ride home` fits `budgetHours`.
BRouter's own estimate is shown alongside for comparison but is not used to
decide anything.

These are the numbers the app *starts* from. Everything under **Settings** in
the interface overrides them and is remembered per browser, so config is where
you write down what you mean rather than where you have to go to change your
mind.

### The two places, and everything else

There are two kinds of thing to set, and the app keeps them apart on purpose.

**The pair you change constantly** — the station you leave from and the point
the ride has to finish at — is the question you are asking. It lives in the
masthead, behind the button that names your station. They are different places,
and the difference is a kilometre of towpath. The station list is thousands
long, so it is searched rather than scrolled: names that begin with what you
typed come first, so "lyon" offers Lyon Part-Dieu before
Bellegarde-sur-Valserine. The finishing point has no list, because it is a spot
on a map: arm **move it** and the next map click is your door. While armed a
click on a station dot places the point rather than selecting the station, since
that is usually exactly where someone aims.

**The answers about you** — when you want to be off a train, how many changes
you will put up with, how long a day you want, how far it is worth looking, and
which way home to offer first — live under **Settings**, and hold across every
question you ask afterwards. Changing the train half re-runs a RAPTOR query in
the worker, which is a few milliseconds. Changing the day half is arithmetic
over rides already fetched. Neither re-routes anything.

The pair and the settings are both remembered. On the next visit the app opens
on the last pair you asked about — not on a town somebody wrote into the source.
Until you have picked one, the map is empty and says so.

### The circle

The map draws a ring around your door, and the stations offered are the ones
inside it. It is a deliberately crude filter: it is drawn before a single road
has been looked at, so a straight line is all it can honestly be. A ride is
never shorter than the crow flight, so a circle drawn by the budget admits
places a real road will not reach — that is the trade — and hides none that
would have worked.

By default the radius is as far as the day could carry you with no train at all.
**Look this far around home** in the settings pins it to something smaller when
you do not want to see that far today.

### Routing from the page

Clicking a station asks BRouter for one way home — the browser has permission,
`brouter.de` answers with `Access-Control-Allow-Origin: *`.

**One request, when you point at something.** Not a hundred on load, not six per
station. The other ways home — quiet roads, gravel, direct — are offered as
outlined buttons under the ride, one request each, and only for the station you
actually picked. brouter.de is donated hardware and the interface is shaped
around that rather than apologising for it afterwards.

**Everything about a routed ride comes from the one response.** Its length, its
climbing, its gradient mix, its surfaces, its hours, whether it fits the day, the
elevation chart, and the .gpx — which is built in the page from the track it was
routed with and handed over as a download. Nothing is left blank because a file
was not written, and nothing on screen belongs to a road to a different door.

**Moving the door aborts whatever is in flight** and clears the rides, because
they all ended somewhere you have left.

`ride.brouterUrl` travels in `plan.json`, so pointing the page at a self-hosted
BRouter is a config change rather than a code change. Without a plan the page
uses the public instance.

### Moving the budget without rebuilding

The day half of **Settings** — `budgetHours`, `minHours`, `maxDays`,
`hoursPerDay` — changes what fits, live, and the map re-decides itself. Nothing
is re-routed, because nothing needs to be: how long a ride takes depends on the
road and your legs, not on how much time you have.

The invariant that keeps it honest: **judging a ride at the settings it was
measured with reproduces that verdict exactly.** Not approximately. If it did
not, the sliders would be quietly showing a different app than the one that
measured the ride, and you would only notice as numbers that move when nothing
was touched.

A ride that does not fit is not hidden. It is struck through in the list and
shown in the panel with what it overruns by, so you can see what a longer day
would buy you rather than guessing at it.

`minHours` is the other end: somewhere you could simply have ridden to is not
worth a train ticket. It is judged against the **most direct** way home, since
that is how far the place really is — taking a longer route back does not turn a
short hop into an outing.

For an overnight trip, raise `maxDays`. Day one gets whatever is left of
`budgetHours` after the train; each later day gets `hoursPerDay`. The ride is
then split at those points, and every overnight stop is tagged with the nearest
station in case you want to give up and take the train.

### How fast you ride

`speedByGradient` is the whole model: pairs of `[gradient in percent, km/h]`,
interpolated between and held flat past either end. Every duration in the
project — the feasibility check, the day splitting, the contours, the profile
chart's time axis — is this list integrated over the shape of the ground.

It replaces the usual touring rule, `km / speedKmh + ascent / climbMetresPerHour`,
which this project used until it did not survive being written out as a speed:

| gradient | the old rule | the curve above |
| --- | --- | --- |
| -10% | 16.0 km/h | 30.2 km/h |
| -3% | 16.0 km/h | 27.0 km/h |
| 0% | 16.0 km/h | 16.0 km/h |
| 3% | 8.9 km/h | 9.5 km/h |
| 5% | 6.9 km/h | 8.0 km/h |
| 10% | 4.4 km/h | 4.3 km/h |

Two things are wrong in that left-hand column. There is no descending in it at
all — you come down a 10% drop at exactly your flat speed — and its rate of
climbing runs backwards, rising from 126 m/h of ascent at 1% to 480 m/h at 15%,
where a rider holding a steady effort is closer to flat across the gradients
roads are actually built at. The curve holds about 420 m/h between 5% and 10%
and gives way above that as the gearing runs out; downhill it peaks around -6%
and falls off again, because a steep descent on a loaded bike is ridden on the
brakes.

Where it changes the answer most is rolling terrain, which is what the Loire and
the Beaujolais are. An 8 km climb at 6% and the 8 km descent off the other side
takes 1h48 under the old rule and 1h23 under the curve.

**The numbers shipped are a starting point, not a measurement.** They are a
loaded tourer on mixed back roads. Replace them with your own — what you really
hold at 5%, how fast you really come down — and every figure in the app moves
with them. A config that still has `speedKmh` and `climbMetresPerHour` and no
`speedByGradient` keeps working: the old rule is turned into the curve it always
implied, descents and all, so an old plan reports the times it always did rather
than silently changing.

### What you are riding on

Gravel is not tarmac, and until recently this timed it as though it were. The
curves are keyed by surface:

```json
"speedByGradient": {
  "paved":   [[-6, 32], [0, 16], [5, 8], [10, 4.3]],
  "unpaved": [[-6, 20], [0, 13], [5, 7.2], [10, 4]]
}
```

Look at where the penalty sits. Loose surface costs you most where you were
going fastest — the descent that is 32 km/h on tarmac is 20 on gravel, because
it is ridden on the brakes — and least on a steep climb, where 4 km/h is 4 km/h
whatever is under the tyre. A single "gravel is twenty percent slower"
multiplier would flatten exactly the structure worth having.

`paved` is required; `unpaved` and `unknown` fall back to it when left out, so
writing a plain list instead of the object means one curve for everything and no
surface modelling at all.

**Where the surface comes from.** BRouter's GeoJSON carries a `messages` table:
one row per stretch of way, with its length and the OpenStreetMap tags on it.
Those tags are read, classified, and matched onto the elevation profile sample
by sample. Nothing extra is fetched — it is in the response already, including
in responses already sitting in your cache.

Classification is a ladder, because `surface` is missing on a great many rural
French ways and refusing to guess would make this useless there:

| Rung | What it reads | Example |
| --- | --- | --- |
| 1 | `surface`, when recognised | `surface=gravel` → unpaved |
| 2 | `tracktype` | `grade1` → paved, `grade2`–`grade5` → unpaved |
| 3 | the kind of road | `highway=residential` → paved, `highway=track` → unpaved |

An untagged `cycleway` or `footway` is taken as surfaced, since an unsigned one
is usually a made-up route through a town; an untagged `path` is not, since in
open country it usually is not.

Anything the ladder cannot place is **unknown**, and unknown takes the *road*
curve. That is deliberate. The pessimistic choice would quietly inflate every
duration in a region that happens to be thinly mapped, and a slow answer that is
wrong for a reason you cannot see is worse than a fast one you have been told to
distrust — so the unrecorded distance is reported in the trip panel instead of
being priced in.

A server that returns no `messages` at all is not an error: every sample becomes
unknown, and the plan is the one you would have had before, just with a line
saying the surface is unrecorded.

Because speed now depends on gradient, and gradient over a few metres of road is
mostly noise off a thirty-metre elevation model, routes are resampled every
`ride.profileStepMetres` and smoothed before they are timed — the same series the
browser is sent for the profile chart, so the two cannot disagree. The ascent
reported beside a ride is measured off that same series rather than taken from
BRouter, for the same reason.

### Ways home

```json
"alternatives": 2,
"variants": [
  { "id": "trekking", "label": "Quiet roads", "profile": "trekking" },
  { "id": "gravel",   "label": "Gravel",      "profile": "gravel"   },
  { "id": "fast",     "label": "Direct",      "profile": "fastbike" }
]
```

`npm run plan` requests each profile `alternatives` times, using BRouter's
`alternativeidx`, giving up to `profiles x alternatives` ways home per station.
Identical results are dropped, and each is checked against the budget
separately — a gravel route can be too slow for a day when the direct one fits.

The app itself asks for one profile at a time: the one under **Offered first**
when you click a station, and the others only when you ask for them by name.
Same list, same labels; the difference is that a script has all night and a page
has somebody waiting.

**The list is ordered quickest first**, not grouped by profile, and routes that
overrun the budget sort to the end. Within a profile the routes are numbered the
same way: "Gravel" is the quickest way home on gravel and "Gravel 2" the longer
one. BRouter's `alternativeidx` does not decide that — it is a request
parameter, not a fact about the road, and its first answer is often the slower
of the two. The exported `.gpx` is named for the same number, so what you
downloaded is what you clicked.

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

Type the new station into the picker and drop the pin. That is the whole of it —
the app is built around the pair being yours to change, and the last one you
used is what it opens on next time.

`config/home.json` is worth updating too if you want `npm run plan` to pre-route
the new place, and it is where a fresh browser gets its first suggestion from.
Nothing else in the project is home-specific.

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
(or whatever `dayType` says). Regional timetables shift a little through the year and
a lot on public holidays, so treat a listed train as "this service normally
runs", not as a booking.

**Bikes on trains are barely in the data.** GTFS has a `bikes_allowed` field and
this feed leaves it empty, so what is offered rests on a rule of thumb: on a
regional train a non-folded bike normally travels free and unreserved, subject
to space. That is a rule of thumb and not a guarantee, and it is why the filter
is a deny list you can see rather than a rule you cannot. TGV and OUIGO are left
out because both want a paid bike reservation, night trains because the space is
limited and reserved, and replacement coaches because they will not take a bike
at all. Intercités are offered, and many of them do want a reservation. Check
before you rely on a specific train.

**The ride home is a suggestion.** BRouter knows the road network, not seasonal
closures, surface condition after rain, or what you find pleasant. Distance comes
from BRouter; the ascent and the riding time are this project's own, off your
speed curve and the smoothed elevation profile, and the "to spare" figure
inherits all of that uncertainty. Treat a route with ten minutes of slack as a
coin flip.

**Surface is modelled, but the tagging behind it is patchy.** Where OpenStreetMap
records what a way is made of, the ride is timed on it; where nobody has, the
stretch is timed at road speed and the panel says how many kilometres that
covers. Treat a route that is a third unrecorded as a guess with a number
attached.

**Stations on one line are a difficulty ladder, not duplicates.** Most of what
comes back from a given home station sits on a handful of lines, and going one
stop further out mostly buys a longer ride over similar ground. The app groups
stations by the line of your final leg for exactly this reason: a corridor
collapses to one row showing the range of rides it offers, and opens into the
stations along it, ordered by ride length. Four lines beat 110 flat rows.

## Which trains, and how they are told apart

This is the least obvious part of the feed, and worth understanding before you
change any of it.

`routes.txt` carries **no usable service type**. Every rail route is
`route_type` 2, the agency is `SNCF VOYAGEURS` for almost all of them, and the
names look like `C30` / `Saint-Étienne - Roanne`. Filtering on names cannot
work.

What does work is the **stop point id**, which encodes the service:

```
StopArea:OCE87726802                the station "Roanne"
  StopPoint:OCETrain TER-87726802     regional trains call here
  StopPoint:OCECar TER-87726802       replacement coaches call here
  StopPoint:OCEINTERCITES-87726802    Intercités call here
```

Every trip calls exclusively at stop points of a single kind — this holds for
all 43,517 trips in the feed — so filtering stops by kind also selects trips.

### Why it is a deny list

The filter is written as **what to leave out**, not what to keep, and that is
the important decision here.

Regional trains are branded by region. It is TER over most of the country, but
**BreizhGo** in Brittany, **Nomad** in Normandy, and **liO**, **Rémi**,
**ZOU!**, **Mobigo**, **Aléop**, **Fluo** elsewhere. Keeping only the kinds you
happened to name loses whole regions *silently*: the trains are in the feed, the
map is simply emptier than the country is, and nothing anywhere says so. Naming
what you are avoiding fails the opposite way — an unfamiliar brand is kept, and
turns up as trains you can look at and reject.

```json
"dropStopKindPatterns": [
  "TGV", "OUIGO", "EUROSTAR", "THALYS", "LYRIA",
  "de nuit", "^OCECar", "^OCEBus", "NAVETTE"
]
```

Patterns, matched case-insensitively against the kind. What they leave out is
long-distance rail — where a bike needs a bag, a reservation, or both — and road
replacements, where it needs a miracle. That `OCECar TER` line matters: those
are **buses replacing trains**, about 5,000 trips, they carry the TER brand,
they would pass any name-based filter, and they will not take your bike.

Intercités are *kept* under this default, where the old TER-only filter dropped
them. Many of them take a bike, and the ones that do not are better seen and
rejected than never offered.

`gtfs.keepStopKinds` is still there as an exact allow list, and overrides the
deny list entirely when you set it. Use it when you know precisely what your
feed contains.

**GTFS has a field for exactly this question** — `bikes_allowed` in `trips.txt`,
where 1 means a bike fits and 2 means it does not. `ingest` reports how many
trips declare it. The SNCF feed leaves it empty at the time of writing, which is
why any of the above is necessary; if that changes, it beats guessing from a
service's name and this filter becomes a fallback.

### When somewhere looks emptier than it should

Every `ingest` prints the kinds the feed contains and what the filter did with
each:

```
Stop kinds in stops.txt:
         6  (station)
  +      3  OCETrain TER
  -      2  OCECar TER
  +      2  OCEINTERCITES
  -      2  OCETGV INOUI
  keeping everything except: TGV, OUIGO, EUROSTAR, THALYS, LYRIA, ...
  note: OUIGO, THALYS matched nothing in this feed — either it carries no such
  service, or the name has changed.
```

That last note is worth reading. A drop pattern that matches nothing is either a
service this feed does not carry, or a name that has changed under you — and the
second one quietly widens what you are planning with.

For one place in particular:

```sh
npm run stations -- Lorient
```

reads the feed **unfiltered** and prints, per station, every kind that calls
there with the lines it carries and a `+`/`-` for what your config does with it.
That is the difference between "no train reaches here in your window" and "the
trains that do are a kind you are leaving out", which is otherwise impossible to
tell apart from the outside.

```sh
npm run ingest -- --explain-routes
```

adds the route-level report: how many routes were read, broken down by
`route_type` with a rail/not-rail verdict, and the kept and dropped labels. **If
the filter leaves nothing, `ingest` prints that automatically** — you never need
a second run to find out why.

`gtfs.keepRoutePatterns` / `gtfs.dropRoutePatterns` remain as an escape hatch,
but default to empty, because in this feed they have nothing useful to match on.

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

Gradient is banded — downhill, flat, 1–3%, 3–6%, 6–9%, 9%+ — on a diverging
scale: climbing on a warm arm that darkens with steepness, descending on a cool
one, flat as the neutral grey between them. Descent gets a band of its own
because it is a different kind of riding rather than a milder version of
climbing: it is where the time goes back in. Every band is labelled, so nothing
rests on colour alone.

The descent step is a muted teal rather than a blue, because the ride line and
the train line are both lines on the same map and blue is the train's. Even so,
**the map folds descent back into the grey.** A thin stroke running a few pixels
from the train's equally thin one reads as a second railway however far apart the
two colours measure — separation thresholds assume marks with some area to them.
In the profile the same colour is a large filled region with nothing blue near
it, so there it stays. The map and the chart carry their own keys, so neither
contradicts itself.

Nothing in the ramp was picked by eye. The climbing arm passes the ordinal checks
— monotone lightness, adjacent lightness gaps, light-end contrast against the
page, single hue — and every pair that touches was measured under normal vision
and under simulated protanopia and deuteranopia: descent against flat, flat
against the first climbing step, and descent against both the train blue and the
contour green it shares the map with.

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

### The mix of a ride

Under the chart is a single stacked bar: what share of the ride falls in each
band. The profile answers "where is the climbing"; this answers "how much of it
is climbing", which is the question you are actually asking when choosing between
six ways home. Reading that off the profile means integrating a wiggly line by
eye, and a fifth of a ride at 6–9% does not look like a fifth of anything when it
is spread over four separate ramps.

The bar divides the ride by **gradient** or by **surface** — one or the other,
never both. Eight or nine segments and two keys would not fit a panel this
tight, and nobody reads a ride as "steep *and* gravel" in a single glance
anyway: you ask one question, then the other. The surface view is the quieter
of the two, since three segments are wide enough to name themselves and it needs
no key at all. Unrecorded surface is hatched rather than merely pale, because it
is the absence of a reading rather than a third kind of ground.

Either way it follows the axis switch, and that is the interesting part. The
same ride divided by gradient, by distance and then by time:

```
distance   40% downhill · 35% flat · 24% at 3–6%
time       29% downhill · 31% flat · 39% at 3–6%
```

Nothing about the road changed. Two fifths of the kilometres are downhill and
under a third of the afternoon is; the climbing goes the other way. Which of
those two readings you want depends on whether you are asking how far the ride
is or how hard it is.

### Distance or time along the bottom

The chart plots against distance by default. The `time` switch above it replots
the same ride against riding time instead, using the same `ride.speedByGradient`
curve as every other duration in the app.

The point of it is that a climb's *width* becomes its duration. On a distance
axis a 3 km wall and 3 km of valley floor take the same width while costing very
different amounts of the day; on a time axis climbs stretch, descents compress,
and the shape of the chart is the shape of the effort. Faint dashed hour lines
give you something to measure against.

It is a second reading of one ride, not a second opinion. The axis is scaled to
end exactly on the duration shown above it: the profile is resampled and
smoothed, so it accumulates slightly less ascent than the full-resolution track
the stated figure comes from, and an axis ending somewhere the panel contradicts
would be worse than a scaled one, and because it keeps the chart honest against
a plan built by an older version of the code.

Profiles are written to `public/data/profiles/`, one small file per ride
(~10 KB), fetched only when you look at that ride.

## Taking a route with you

Every ride gets a GPX, linked from the trip panel — including rides that overrun
the budget, since the route exists and you may want it for a longer day. A ride
routed in the page builds it there, from the track it was just routed with; one
that came out of `npm run plan` is a file in `public/data/gpx/`.

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

## The timetable, packed for the browser

`npm run ingest` writes the parsed timetable alongside the feed it came from:

```
public/data/timetable.json       structure: stops, patterns, trips, calendars
public/data/timetable.times.bin  every call time, as one Int32Array
```

Parsing the feed costs a 4 MB zip and 378,000 CSV rows and takes seconds. That
is fine once on a laptop and impossible on every page visit, so it happens once
and the result is written out. On the real SNCF feed — 2,497 stops, 3,670
patterns, 28,600 trips, 304,000 calls — `ingest` reports:

| | raw | over the wire |
| --- | --- | --- |
| `timetable.json` | 6.6 MB | 703 KB |
| `timetable.times.bin` | 2.2 MB | ~160 KB |
| | | **~860 KB** |

The raw figures matter only if you serve it without compression; the
fixed-width times array is nearly all zero bytes and gzips sixteenfold.

Most of the structure is calendars. This feed ships no `calendar.txt`, so every
service day is an explicit date in `calendar_dates.txt`, and there are tens of
thousands of distinct services — which is also why 56,000 strings are interned
rather than a few thousand. Storing those dates as day offsets from the feed
start, rather than as `20260829`, would cut the structure substantially; it has
not been done because 860 KB is already a normal payload.

**Two files, split where the bytes are.** Times are three quarters of the index
and the only part that wants to be a typed array — in memory an `Int32Array`
costs a quarter of what the same numbers cost as a JS array, and RAPTOR reads
each trip as a view onto the one shared buffer rather than a copy. Everything
else stays JSON: small, compressible, and openable in an editor when something
looks wrong. Hand-rolling a binary header for another hundred kilobytes would
trade that away for exactly the class of bug — one field's offset out by one —
that stays invisible until a single train has the wrong departure time.

Times are seconds, in `Int32Array`, not minutes in a `Uint16Array`. Minutes
would halve the raw size and silently round any feed that publishes seconds.

**It is read in a worker.** `web/src/timetable.worker.ts` hosts a
`TimetableService`, and `Timetable` in `timetableClient.ts` wraps it as
promise-returning calls. Requests carry an id and replies quote it, so several
can be in flight and none has to be the next one back — a query fired while a
slider is still moving must not be mistaken for the answer to the one after it.

Measured in Chromium on a synthetic index at three quarters of the real feed's
size: **182 ms** to fetch, parse and unpack both files, and **10 ms** per query
over 3,670 patterns, with no long task on the main thread at any point.
Switching home station is one of those queries.

**Nothing derived is stored.** `stopIndex`, `stopsInStation` and
`patternsAtStop` are rebuilt on load by `deriveLookups` — the same function the
parser calls, so the browser cannot end up with a different view of the feed
than the planner has.

The test that matters is that a packed index, put through `JSON.stringify` and
read back, deep-equals the one that went in — every stop, every trip's times,
every calendar, every derived lookup — and answers a RAPTOR query identically.

## Commands

```sh
npm run ingest                 # download, validate, pack for the browser
npm run plan                   # optional: pre-route every ride home
npm run stations -- Lyon       # what calls at a station, unfiltered
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
| `web/` | React + MapLibre front end. Reads the packed timetable, runs RAPTOR in a worker, and calls BRouter on demand. |

`timetable.json` plus `timetable.times.bin` is the contract between the two
halves: the site is static, and everything it does afterwards it does in the
browser. `plan.json`, when present, is a cache of rides already routed for one
pair of places.

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
