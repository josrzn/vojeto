/**
 * GPX writing.
 *
 * Deliberately fed the router's full track rather than the simplified line the
 * map draws: 150 m of tolerance is invisible on screen and useless on a device
 * at a junction, and the map geometry drops elevation altogether.
 */
import { haversine } from "../shared/geo.js";

export interface GpxWaypoint {
  lat: number;
  lon: number;
  name: string;
  description?: string;
}

export interface GpxOptions {
  name: string;
  description?: string;
  /** [lon, lat] or [lon, lat, elevation]. */
  coordinates: number[][];
  waypoints?: GpxWaypoint[];
  /** ISO timestamp for the metadata block. */
  time?: string;
}

const escapeXml = (value: string): string =>
  value.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;",
  );

const coord = (value: number): string => value.toFixed(6);

export function toGpx(options: GpxOptions): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="vojeto" xmlns="http://www.topografix.com/GPX/1/1">',
    "  <metadata>",
    `    <name>${escapeXml(options.name)}</name>`,
  ];
  if (options.description) lines.push(`    <desc>${escapeXml(options.description)}</desc>`);
  if (options.time) lines.push(`    <time>${escapeXml(options.time)}</time>`);
  lines.push("  </metadata>");

  for (const waypoint of options.waypoints ?? []) {
    lines.push(`  <wpt lat="${coord(waypoint.lat)}" lon="${coord(waypoint.lon)}">`);
    lines.push(`    <name>${escapeXml(waypoint.name)}</name>`);
    if (waypoint.description) lines.push(`    <desc>${escapeXml(waypoint.description)}</desc>`);
    lines.push("  </wpt>");
  }

  lines.push("  <trk>", `    <name>${escapeXml(options.name)}</name>`, "    <trkseg>");
  for (const point of options.coordinates) {
    const [lon, lat, elevation] = point;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (Number.isFinite(elevation)) {
      lines.push(
        `      <trkpt lat="${coord(lat!)}" lon="${coord(lon!)}"><ele>${elevation!.toFixed(1)}</ele></trkpt>`,
      );
    } else {
      lines.push(`      <trkpt lat="${coord(lat!)}" lon="${coord(lon!)}" />`);
    }
  }
  lines.push("    </trkseg>", "  </trk>", "</gpx>", "");
  return lines.join("\n");
}

/**
 * The one-line summary that goes in a track's <desc>.
 *
 * Carries both names on purpose: the label is this project's own gloss and the
 * profile is what BRouter was actually asked for, so seeing the raw name in a
 * file does not leave you wondering which is which. Where they coincide, only
 * one is shown.
 */
export function describeRide(ride: {
  km: number;
  ascentMetres: number;
  hours: number;
  label: string;
  profile: string;
}): string {
  const via =
    ride.label.toLowerCase() === ride.profile.toLowerCase()
      ? ride.profile
      : `${ride.profile} (${ride.label})`;
  return (
    `${ride.km.toFixed(0)} km, ${ride.ascentMetres} m of climbing, ` +
    `about ${ride.hours.toFixed(1)} h riding via ${via}`
  );
}

/**
 * Inserts points so no segment exceeds `maxMetres`.
 *
 * The router emits one point per OSM node, so a straight rural road can run a
 * kilometre between two of them. That is a faithful description of the route,
 * but importers that map-match a track to their own network have nothing to
 * match against over such a gap and report the stretch as leaving known ways.
 *
 * Interpolating along the segment adds no information and cannot invent a bend
 * that is not there — which is exactly why it is safe: on a straight run the
 * inserted points lie on the road, and where the source is dense already
 * nothing is added at all.
 */
export function densify(coordinates: number[][], maxMetres: number): number[][] {
  if (maxMetres <= 0 || coordinates.length < 2) return coordinates;

  const out: number[][] = [coordinates[0]!];
  for (let i = 1; i < coordinates.length; i++) {
    const a = coordinates[i - 1]!;
    const b = coordinates[i]!;
    const span = haversine({ lon: a[0]!, lat: a[1]! }, { lon: b[0]!, lat: b[1]! });
    const steps = Math.ceil(span / maxMetres);
    for (let step = 1; step < steps; step++) {
      const t = step / steps;
      const point: number[] = [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t];
      if (Number.isFinite(a[2]) && Number.isFinite(b[2])) {
        point.push(a[2]! + (b[2]! - a[2]!) * t);
      }
      out.push(point);
    }
    out.push(b);
  }
  return out;
}

/** A filename-safe slug: accents folded, punctuation dropped. */
export function slug(value: string): string {
  return (
    value
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "track"
  );
}
