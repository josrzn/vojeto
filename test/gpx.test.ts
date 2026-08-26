import { describe, expect, it } from "vitest";
import { slug, toGpx } from "../src/bike/gpx.js";

const track = [
  [4.86, 45.7605, 210.4],
  [4.7, 45.8, 305],
  [4.0793, 46.0344, 280.2],
];

describe("toGpx", () => {
  it("writes a well-formed document with one point per coordinate", () => {
    const gpx = toGpx({ name: "Mâcon to home", coordinates: track });
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx.trimEnd().endsWith("</gpx>")).toBe(true);
    expect(gpx.match(/<trkpt /g)).toHaveLength(3);
  });

  it("keeps elevation, which the map geometry throws away", () => {
    expect(toGpx({ name: "x", coordinates: track })).toContain("<ele>210.4</ele>");
  });

  it("writes lat and lon the right way round", () => {
    // GeoJSON is [lon, lat]; GPX attributes are the other way about.
    expect(toGpx({ name: "x", coordinates: [[4.86, 45.7605]] })).toContain(
      'lat="45.760500" lon="4.860000"',
    );
  });

  it("omits elevation for points that have none", () => {
    const gpx = toGpx({ name: "x", coordinates: [[4.86, 45.76]] });
    expect(gpx).toContain("<trkpt");
    expect(gpx).not.toContain("<ele>");
  });

  it("skips points with unusable coordinates", () => {
    const gpx = toGpx({ name: "x", coordinates: [[4.86, 45.76], [NaN, 1], [4.9, 45.8]] });
    expect(gpx.match(/<trkpt /g)).toHaveLength(2);
  });

  it("escapes names so an apostrophe cannot break the document", () => {
    const gpx = toGpx({ name: "L'Arbresle & <home>", coordinates: track });
    expect(gpx).toContain("L&apos;Arbresle &amp; &lt;home&gt;");

    // Inside every <name>, no raw markup characters and no bare ampersand.
    for (const [, body] of gpx.matchAll(/<name>(.*?)<\/name>/g)) {
      expect(body).not.toMatch(/[<>]/);
      expect(body).not.toMatch(/&(?!(amp|lt|gt|apos|quot);)/);
    }
  });

  it("writes overnight stops as waypoints", () => {
    const gpx = toGpx({
      name: "x",
      coordinates: track,
      waypoints: [{ lat: 46.1, lon: 4.2, name: "Night 1", description: "near Tarare" }],
    });
    expect(gpx).toContain('<wpt lat="46.100000" lon="4.200000">');
    expect(gpx).toContain("<name>Night 1</name>");
    expect(gpx).toContain("<desc>near Tarare</desc>");
  });

  it("handles an empty track without producing broken XML", () => {
    const gpx = toGpx({ name: "x", coordinates: [] });
    expect(gpx).toContain("<trkseg>");
    expect(gpx).toContain("</trkseg>");
    expect(gpx).not.toContain("<trkpt");
  });
});

describe("slug", () => {
  it("folds accents and punctuation into a filename", () => {
    expect(slug("Mâcon")).toBe("macon");
    expect(slug("L'Arbresle")).toBe("l-arbresle");
    expect(slug("Saint-Étienne Châteaucreux")).toBe("saint-etienne-chateaucreux");
  });

  it("never returns an empty string", () => {
    expect(slug("///")).toBe("track");
    expect(slug("")).toBe("track");
  });

  it("bounds the length", () => {
    expect(slug("a".repeat(200)).length).toBeLessThanOrEqual(60);
  });
});
