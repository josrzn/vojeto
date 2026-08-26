/**
 * GPX writing.
 *
 * Deliberately fed the router's full track rather than the simplified line the
 * map draws: 150 m of tolerance is invisible on screen and useless on a device
 * at a junction, and the map geometry drops elevation altogether.
 */
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
