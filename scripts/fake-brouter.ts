/**
 * A stand-in for BRouter, for developing the UI without hitting the real
 * service. It fabricates a wiggly great-circle line between the waypoints, so
 * distances are roughly right but the roads are entirely fictional.
 *
 *   npx tsx scripts/fake-brouter.ts 17777
 *   npm run plan -- --brouter http://127.0.0.1:17777/brouter
 */
import { createServer } from "node:http";
import { cumulativeDistances } from "../src/shared/geo.js";

const port = Number(process.argv[2] ?? 17777);

createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);
  const lonlats = (url.searchParams.get("lonlats") ?? "")
    .split("|")
    .map((pair) => pair.split(",").map(Number))
    .filter((pair) => pair.length === 2 && pair.every(Number.isFinite));

  if (lonlats.length < 2) {
    response.writeHead(400, { "Content-Type": "text/plain" });
    response.end("expected at least two lonlats");
    return;
  }

  const [from, to] = [lonlats[0]!, lonlats.at(-1)!];
  // Vary the shape by profile and alternative, so the variants are visibly
  // different in the UI rather than all landing on the same line.
  const profile = url.searchParams.get("profile") ?? "trekking";
  const alternative = Number(url.searchParams.get("alternativeidx") ?? 0);
  const seed =
    [...profile].reduce((total, c) => total + c.charCodeAt(0), 0) + alternative * 37;
  const amplitude = 0.03 + ((seed % 7) / 7) * 0.06;
  const lobes = 2 + (seed % 4);
  const steps = 240;
  const coordinates: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // A sine wave across the direct line, so the track is not a straight edge.
    const wobble = Math.sin(t * Math.PI * lobes) * amplitude * (1 - Math.abs(2 * t - 1));
    coordinates.push([
      from[0]! + (to[0]! - from[0]!) * t + wobble,
      from[1]! + (to[1]! - from[1]!) * t - wobble * 0.6,
      Math.round(250 + (300 + (seed % 5) * 90) * Math.sin(t * Math.PI * 2.5) ** 2),
    ]);
  }

  const metres = cumulativeDistances(coordinates).at(-1) ?? 0;
  let ascent = 0;
  for (let i = 1; i < coordinates.length; i++) {
    ascent += Math.max(0, coordinates[i]![2]! - coordinates[i - 1]![2]!);
  }

  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            "track-length": String(Math.round(metres)),
            "filtered ascend": String(Math.round(ascent)),
            "total-time": String(Math.round((metres / 1000 / 17) * 3600)),
          },
          geometry: { type: "LineString", coordinates },
        },
      ],
    }),
  );
}).listen(port, "127.0.0.1", () => {
  console.log(`Fake BRouter listening on http://127.0.0.1:${port}/brouter`);
});
