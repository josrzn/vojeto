import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { gzip } from "node:zlib";
import { loadConfig } from "./config.js";
import { downloadFeed, listMembers } from "./gtfs/archive.js";
import { loadTimetable } from "./gtfs/load.js";
import { packTimetable } from "./gtfs/pack.js";
import type { TimetableIndex } from "./shared/types.js";
import { formatDate } from "./gtfs/time.js";
import { buildPlan, writePlan } from "./build/buildPlan.js";
import { resolveHome, searchStations } from "./build/stations.js";
import { sampleDates } from "./build/dates.js";
import { keepKind, stopKind, type KindFilter } from "./gtfs/serviceKind.js";
import { sampleRideField, sampleCount } from "./bike/field.js";
import type { Grid } from "./bike/contour.js";

const DATA_DIR = "data";
const FEED_FILE = path.join(DATA_DIR, "sncf-gtfs.zip");
const CACHE_DIR = path.join(DATA_DIR, "brouter-cache");
const PLAN_FILE = path.join("public", "data", "plan.json");
const GPX_DIR = path.join("public", "data", "gpx");
const PROFILE_DIR = path.join("public", "data", "profiles");
const TIMETABLE_FILE = path.join("public", "data", "timetable.json");
const TIMETABLE_TIMES_FILE = path.join("public", "data", "timetable.times.bin");

interface Flags {
  command: string;
  rest: string[];
  explainRoutes: boolean;
  skipBike: boolean;
  field: boolean;
  limit: number | undefined;
  feed: string | undefined;
  brouter: string | undefined;
  maxAgeHours: number;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    command: "",
    rest: [],
    explainRoutes: false,
    skipBike: false,
    field: false,
    limit: undefined,
    feed: undefined,
    brouter: undefined,
    maxAgeHours: 24,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--explain-routes") flags.explainRoutes = true;
    else if (arg === "--skip-bike") flags.skipBike = true;
    else if (arg === "--field") flags.field = true;
    else if (arg === "--limit") flags.limit = Number(argv[++i]);
    else if (arg === "--feed") flags.feed = argv[++i];
    else if (arg === "--brouter") flags.brouter = argv[++i];
    else if (arg === "--max-age-hours") flags.maxAgeHours = Number(argv[++i]);
    else if (!flags.command) flags.command = arg;
    else flags.rest.push(arg);
  }
  return flags;
}

/** Downloads the feed unless --feed pointed at a local copy. */
/**
 * What calls at a station, by service kind, with the lines each kind carries.
 *
 * The answer to "why is there nothing at Lorient": either no train reaches it
 * in your window, or the trains that do are a kind your config leaves out. Only
 * the feed can tell the two apart, and only if nothing has been filtered before
 * you look.
 */
function servicesAt(index: TimetableIndex, stationId: string): Array<[string, Set<string>]> {
  const byKind = new Map<string, Set<string>>();
  for (const stopIndex of index.stopsInStation.get(stationId) ?? []) {
    const stop = index.stops[stopIndex];
    if (!stop) continue;
    const kind = stopKind(stop.id) ?? "(no kind)";
    let routes = byKind.get(kind);
    if (!routes) byKind.set(kind, (routes = new Set<string>()));
    for (const patternId of index.patternsAtStop[stopIndex] ?? []) {
      const trip = index.patterns[patternId]?.trips[0];
      if (trip) routes.add(trip.routeName);
    }
  }
  return [...byKind].sort((a, b) => a[0].localeCompare(b[0]));
}

async function feedPath(flags: Flags, url: string): Promise<string> {
  if (flags.feed) return flags.feed;
  if (!url) throw new Error("config/home.json: gtfs.url is empty, or pass --feed <path>");
  return downloadFeed(url, FEED_FILE, flags.maxAgeHours);
}

/**
 * Writes the parsed timetable for the browser to read.
 *
 * Parsing the feed costs a 4 MB zip and several hundred thousand CSV rows, which
 * is fine once on a laptop and not something a page can do on every visit. This
 * is the same index, in a shape that loads in one JSON.parse and one fetch of a
 * typed array.
 */
async function writeTimetable(index: TimetableIndex): Promise<void> {
  const { meta, times } = packTimetable(index);
  const json = JSON.stringify(meta);

  await mkdir(path.dirname(TIMETABLE_FILE), { recursive: true });
  await writeFile(TIMETABLE_FILE, json);
  await writeFile(TIMETABLE_TIMES_FILE, Buffer.from(times.buffer, times.byteOffset, times.byteLength));

  const kb = (bytes: number) =>
    bytes < 10 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${Math.round(bytes / 1024)} KB`;
  const gzipped = await new Promise<number>((resolve, reject) => {
    gzip(json, (error, buffer) => (error ? reject(error) : resolve(buffer.byteLength)));
  });
  console.log(
    `\nTimetable index: ${kb(json.length)} of structure (${kb(gzipped)} gzipped) ` +
      `plus ${kb(times.byteLength)} of times, ` +
      `${meta.strings.length.toLocaleString()} distinct strings`,
  );
  console.log(`  ${TIMETABLE_FILE}\n  ${TIMETABLE_TIMES_FILE}`);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const config = await loadConfig();

  switch (flags.command) {
    case "ingest": {
      const feed = await feedPath(flags, config.gtfs.url);
      if (!flags.feed) console.log(`Archive contains: ${(await listMembers(feed)).join(", ")}`);

      const index = await loadTimetable({
        zipPath: feed,
        keepRoutePatterns: config.gtfs.keepRoutePatterns,
        dropRoutePatterns: config.gtfs.dropRoutePatterns,
        ...(config.gtfs.keepRouteTypes ? { keepRouteTypes: config.gtfs.keepRouteTypes } : {}),
        keepStopKinds: config.gtfs.keepStopKinds,
        dropStopKindPatterns: config.gtfs.dropStopKindPatterns,
        explainRoutes: flags.explainRoutes,
      });

      const home = resolveHome(index, config.home.station);
      const dates = sampleDates(index.feedStart, index.plannableEnd, config.dayType);
      console.log(
        `\nFeed declares ${formatDate(index.feedStart)} to ${formatDate(index.feedEnd)}; ` +
          `plannable to ${formatDate(index.plannableEnd)}` +
          ` (${dates.length} months)`,
      );
      console.log(`Home resolves to ${home.name} (${home.stationId})`);
      console.log(
        `Ride home ends at ${config.home.rideTo.lat.toFixed(5)}, ` +
          `${config.home.rideTo.lon.toFixed(5)}`,
      );
      console.log(`Sample dates: ${dates.map((d) => d.date).map(formatDate).join(", ")}`);

      await writeTimetable(index);
      break;
    }

    case "stations": {
      const query = flags.rest.join(" ");
      if (!query) throw new Error("Usage: npm run stations -- <name>");
      const feed = await feedPath(flags, config.gtfs.url);
      // Deliberately unfiltered, unlike every other command. This is the tool
      // you reach for when somewhere looks emptier than it should, and it can
      // only answer that by showing what your filter is leaving out.
      console.log("Reading the whole feed, with no service filter…\n");
      const index = await loadTimetable({
        zipPath: feed,
        keepRoutePatterns: [],
        dropRoutePatterns: [],
        keepStopKinds: [],
        dropStopKindPatterns: [],
      });
      const filter: KindFilter = {
        keep: new Set(config.gtfs.keepStopKinds),
        drop: config.gtfs.dropStopKindPatterns,
      };
      const matches = searchStations(index, query);
      if (matches.length === 0) console.log(`No station matches ${JSON.stringify(query)}`);
      for (const match of matches.slice(0, 30)) {
        console.log(`\n${match.stationId}\t${match.name}\t${match.lat},${match.lon}`);
        for (const [kind, routes] of servicesAt(index, match.stationId)) {
          const kept = keepKind(kind, filter);
          console.log(
            `  ${kept ? "+" : "-"} ${kind}${kept ? "" : "  (left out by your config)"}`,
          );
          console.log(`      ${[...routes].slice(0, 6).join(", ")}`);
        }
      }
      break;
    }

    case "plan": {
      const feed = await feedPath(flags, config.gtfs.url);
      const index = await loadTimetable({
        zipPath: feed,
        keepRoutePatterns: config.gtfs.keepRoutePatterns,
        dropRoutePatterns: config.gtfs.dropRoutePatterns,
        ...(config.gtfs.keepRouteTypes ? { keepRouteTypes: config.gtfs.keepRouteTypes } : {}),
        keepStopKinds: config.gtfs.keepStopKinds,
        dropStopKindPatterns: config.gtfs.dropStopKindPatterns,
        explainRoutes: flags.explainRoutes,
      });
      if (flags.brouter) config.ride.brouterUrl = flags.brouter;

      let field: Grid | null = null;
      if (flags.field && !flags.skipBike) {
        const { spacingKm, radiusKm } = config.ride.field;
        const requests = sampleCount(radiusKm, spacingKm);
        console.log(
          `\nSampling ride time home every ${spacingKm} km out to ${radiusKm.toFixed(0)} km: ` +
            `${requests} routing requests (about ${Math.ceil(requests / 60)} min uncached)`,
        );
        let lastReport = 0;
        const result = await sampleRideField(config.home.rideTo, {
          baseUrl: config.ride.brouterUrl,
          cacheDir: CACHE_DIR,
          profile: config.ride.variants[0]?.profile ?? "trekking",
          effort: config.ride.effort,
          profileStepMetres: config.ride.profileStepMetres,
          radiusKm,
          spacingKm,
          onProgress: (done, total) => {
            if (done - lastReport < 50 && done !== total) return;
            lastReport = done;
            console.log(`  field: ${done}/${total}`);
          },
        });
        field = result.grid;
        console.log(
          `  field: ${result.sampled} routed, ${result.failed} with no route, ` +
            `${result.skipped} outside the radius (never tried)`,
        );
        if (result.failed > result.sampled * 0.02) {
          console.warn(
            `  warning: ${result.failed} samples failed. Each one punches a hole through\n` +
              `  every contour near it, which is what makes the rings look broken. A shared\n` +
              `  BRouter often refuses long routes; try a smaller ride.field.radiusKm, or\n` +
              `  run your own instance and pass --brouter.`,
          );
        }
      }

      const plan = await buildPlan(index, config, {
        cacheDir: CACHE_DIR,
        gpxDir: GPX_DIR,
        profileDir: PROFILE_DIR,
        skipBike: flags.skipBike,
        field,
        ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
      });
      await writePlan(plan, PLAN_FILE);
      const total = new Set(plan.months.flatMap((m) => m.destinations.map((d) => d.stationId)));
      console.log(`${total.size} distinct destinations across ${plan.months.length} months`);
      break;
    }

    default:
      console.log(
        [
          "Usage: npm run <command>",
          "",
          "  ingest      download the feed and check it against your config",
          "  plan        build public/data/plan.json for the web app",
          "  stations    what calls at a station, with no service filter applied",
          "",
          "Flags:",
          "  --feed <path>        use a local .zip or extracted directory instead of downloading",
        "  --brouter <url>      route against another BRouter, e.g. a local instance",
          "  --explain-routes     list every route label and whether the filter kept it",
          "  --skip-bike          train results only, no BRouter calls",
        "  --field              also sample ride time home on a grid, for the map backdrop",
          "  --limit <n>          only route the n nearest destinations home",
          "  --max-age-hours <n>  re-download the feed if the cached copy is older",
        ].join("\n"),
      );
      process.exitCode = flags.command ? 1 : 0;
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
