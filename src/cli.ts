import path from "node:path";
import { loadConfig } from "./config.js";
import { downloadFeed, listMembers } from "./gtfs/archive.js";
import { loadTimetable } from "./gtfs/load.js";
import { formatDate } from "./gtfs/time.js";
import { buildPlan, writePlan } from "./build/buildPlan.js";
import { resolveHome, searchStations } from "./build/stations.js";
import { sampleDates } from "./build/dates.js";

const DATA_DIR = "data";
const FEED_FILE = path.join(DATA_DIR, "sncf-gtfs.zip");
const CACHE_DIR = path.join(DATA_DIR, "brouter-cache");
const PLAN_FILE = path.join("public", "data", "plan.json");

interface Flags {
  command: string;
  rest: string[];
  explainRoutes: boolean;
  skipBike: boolean;
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
    limit: undefined,
    feed: undefined,
    brouter: undefined,
    maxAgeHours: 24,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--explain-routes") flags.explainRoutes = true;
    else if (arg === "--skip-bike") flags.skipBike = true;
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
async function feedPath(flags: Flags, url: string): Promise<string> {
  if (flags.feed) return flags.feed;
  if (!url) throw new Error("config/home.json: gtfs.url is empty, or pass --feed <path>");
  return downloadFeed(url, FEED_FILE, flags.maxAgeHours);
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
        explainRoutes: flags.explainRoutes,
      });

      const home = resolveHome(index, config.home);
      const dates = sampleDates(index.feedStart, index.feedEnd, config.dayType);
      console.log(
        `\nFeed covers ${formatDate(index.feedStart)} to ${formatDate(index.feedEnd)}` +
          ` (${dates.length} plannable months)`,
      );
      console.log(`Home resolves to ${home.name} (${home.stationId})`);
      console.log(`Sample dates: ${dates.map((d) => d.date).map(formatDate).join(", ")}`);
      break;
    }

    case "stations": {
      const query = flags.rest.join(" ");
      if (!query) throw new Error("Usage: npm run stations -- <name>");
      const feed = await feedPath(flags, config.gtfs.url);
      const index = await loadTimetable({
        zipPath: feed,
        keepRoutePatterns: config.gtfs.keepRoutePatterns,
        dropRoutePatterns: config.gtfs.dropRoutePatterns,
      });
      const matches = searchStations(index, query);
      if (matches.length === 0) console.log(`No station matches ${JSON.stringify(query)}`);
      for (const match of matches.slice(0, 30)) {
        console.log(`${match.stationId}\t${match.name}\t${match.lat},${match.lon}`);
      }
      break;
    }

    case "plan": {
      const feed = await feedPath(flags, config.gtfs.url);
      const index = await loadTimetable({
        zipPath: feed,
        keepRoutePatterns: config.gtfs.keepRoutePatterns,
        dropRoutePatterns: config.gtfs.dropRoutePatterns,
        explainRoutes: flags.explainRoutes,
      });
      if (flags.brouter) config.bike.brouterUrl = flags.brouter;
      const plan = await buildPlan(index, config, {
        cacheDir: CACHE_DIR,
        skipBike: flags.skipBike,
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
          "  stations    search station names in the feed",
          "",
          "Flags:",
          "  --feed <path>        use a local .zip or extracted directory instead of downloading",
        "  --brouter <url>      route against another BRouter, e.g. a local instance",
          "  --explain-routes     list every route label and whether the filter kept it",
          "  --skip-bike          train results only, no BRouter calls",
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
