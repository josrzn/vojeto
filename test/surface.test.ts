import { describe, expect, it } from "vitest";
import {
  classifySurface,
  parseTags,
  surfaceEvidence,
  surfaceShares,
  surfacesAlong,
  type Surface,
} from "../src/bike/surface.js";
import { parseWays } from "../src/bike/brouter.js";

/**
 * The header and two rows of a real brouter.de response, verbatim.
 *
 * Kept exactly as the server sent it — integer coordinates, per-segment
 * distances, BRouter's own `reversedirection` mixed in with the OSM tags —
 * because every one of those is something a hand-written fixture would have
 * quietly got wrong.
 */
const MESSAGES = [
  [
    "Longitude",
    "Latitude",
    "Elevation",
    "Distance",
    "CostPerKm",
    "ElevCost",
    "TurnCost",
    "NodeCost",
    "InitialCost",
    "WayTags",
    "NodeTags",
    "Time",
    "Energy",
  ],
  [
    "4078967",
    "46034531",
    "269",
    "81",
    "1050",
    "0",
    "104",
    "0",
    "0",
    "reversedirection=yes highway=footway surface=concrete foot=yes bicycle=yes",
    "highway=crossing",
    "13",
    "1360",
  ],
  [
    "4078651",
    "46034648",
    "270",
    "28",
    "1350",
    "0",
    "91",
    "0",
    "0",
    "highway=track surface=gravel tracktype=grade3",
    "",
    "9",
    "700",
  ],
];

describe("parseWays", () => {
  it("reads a real response's messages table", () => {
    const ways = parseWays(MESSAGES);
    expect(ways).toHaveLength(2);
    expect(ways[0]!.metres).toBe(81);
    expect(ways[1]!.metres).toBe(28);
    expect(ways[0]!.tags["surface"]).toBe("concrete");
    expect(ways[1]!.tags["tracktype"]).toBe("grade3");
  });

  it("finds the columns by name, not by position", () => {
    // The same two rows with the columns shuffled must give the same answer.
    const [header, ...rows] = MESSAGES;
    const order = [9, 3, 0];
    const shuffled = [order.map((i) => header![i]!), ...rows.map((r) => order.map((i) => r[i]!))];
    expect(parseWays(shuffled)).toEqual(parseWays(MESSAGES));
  });

  it("returns nothing rather than guessing when the table is missing", () => {
    expect(parseWays(undefined)).toEqual([]);
    expect(parseWays([])).toEqual([]);
    expect(parseWays([MESSAGES[0]])).toEqual([]);
    expect(parseWays("not a table")).toEqual([]);
    // A table without the columns we need is no better than no table.
    expect(parseWays([["Longitude", "Latitude"], ["1", "2"]])).toEqual([]);
  });

  it("skips a row with no length rather than emitting a zero-length stretch", () => {
    const withJunk = [MESSAGES[0], ["0", "0", "0", "0", "", "", "", "", "", "highway=track"]];
    expect(parseWays(withJunk)).toEqual([]);
  });
});

describe("parseTags", () => {
  it("splits BRouter's space-separated pairs", () => {
    expect(parseTags("highway=track surface=gravel tracktype=grade3")).toEqual({
      highway: "track",
      surface: "gravel",
      tracktype: "grade3",
    });
  });

  it("keeps values containing an equals sign intact", () => {
    expect(parseTags("name=Rue=Basse highway=residential")["name"]).toBe("Rue=Basse");
  });

  it("survives empty and malformed input", () => {
    expect(parseTags("")).toEqual({});
    expect(parseTags("   ")).toEqual({});
    expect(parseTags("nonsense highway=track")).toEqual({ highway: "track" });
    expect(parseTags("=leading highway=track")).toEqual({ highway: "track" });
  });
});

describe("classifySurface", () => {
  const of = (tags: string) => classifySurface(parseTags(tags));

  it("believes an explicit surface above everything else", () => {
    expect(of("highway=track surface=asphalt")).toBe("paved");
    expect(of("highway=residential surface=gravel")).toBe("unpaved");
    // Even against a tracktype that says otherwise.
    expect(of("highway=track surface=asphalt tracktype=grade4")).toBe("paved");
  });

  it("falls back to tracktype, which is often all a track has", () => {
    expect(of("highway=track tracktype=grade1")).toBe("paved");
    expect(of("highway=track tracktype=grade2")).toBe("unpaved");
    expect(of("highway=track tracktype=grade5")).toBe("unpaved");
  });

  it("falls back to the kind of road as a last resort", () => {
    expect(of("highway=residential")).toBe("paved");
    expect(of("highway=secondary")).toBe("paved");
    expect(of("highway=track")).toBe("unpaved");
    expect(of("highway=path")).toBe("unpaved");
  });

  it("treats an untagged cycleway or footway as surfaced, a path as not", () => {
    // An unsigned cycleway is usually a surfaced route through a town; an
    // unsigned path in open country usually is not.
    expect(of("highway=cycleway")).toBe("paved");
    expect(of("highway=footway")).toBe("paved");
    expect(of("highway=path")).toBe("unpaved");
  });

  it("says unknown rather than folding a mystery into a neighbour", () => {
    expect(of("")).toBe("unknown");
    expect(of("highway=ferry")).toBe("unknown");
    expect(of("surface=something_nobody_has_heard_of")).toBe("unknown");
    expect(of("name=Chemin des Vignes")).toBe("unknown");
  });

  it("classifies the two real rows", () => {
    const ways = parseWays(MESSAGES);
    expect(classifySurface(ways[0]!.tags)).toBe("paved");
    expect(classifySurface(ways[1]!.tags)).toBe("unpaved");
  });
});

describe("surfaceEvidence", () => {
  const of = (tags: string) => surfaceEvidence(parseTags(tags));

  it("reports which rung of the ladder answered", () => {
    expect(of("highway=track surface=gravel")).toBe("surface");
    expect(of("highway=track tracktype=grade3")).toBe("tracktype");
    expect(of("highway=track")).toBe("highway");
    expect(of("name=Chemin")).toBe("none");
  });

  it("does not count a surface value it could not place", () => {
    expect(of("highway=track surface=nonsense")).toBe("highway");
  });
});

describe("surfacesAlong", () => {
  const way = (metres: number, tags: string) => ({ metres, tags: parseTags(tags) });

  it("puts each sample on the stretch it rides over", () => {
    // 1 km of road then 1 km of track, sampled every 500 m.
    const ways = [way(1000, "highway=residential"), way(1000, "highway=track")];
    const surfaces = surfacesAlong(ways, [0, 0.5, 1, 1.5, 2]);
    // Samples 1 and 2 cover 0–0.5 and 0.5–1, both on the road; 3 and 4 the track.
    expect(surfaces.slice(1)).toEqual(["paved", "paved", "unpaved", "unpaved"]);
  });

  it("still lines up when BRouter's total differs from ours", () => {
    // The ways declare 2 km; the polyline measures 2.2. Without scaling, the
    // last 200 m would fall off the end of the table and take the wrong surface.
    const ways = [way(1000, "highway=residential"), way(1000, "highway=track")];
    const surfaces = surfacesAlong(ways, [0, 0.55, 1.1, 1.65, 2.2]);
    expect(surfaces.slice(1)).toEqual(["paved", "paved", "unpaved", "unpaved"]);
    expect(surfaces.at(-1)).toBe("unpaved");
  });

  it("says unknown throughout when the server reported no tags", () => {
    expect(surfacesAlong([], [0, 1, 2])).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("returns one entry per sample, and nothing for nothing", () => {
    const ways = [way(1000, "highway=track")];
    expect(surfacesAlong(ways, [0, 1])).toHaveLength(2);
    expect(surfacesAlong(ways, [])).toEqual([]);
  });

  it("does not run off the end of the table on a degenerate route", () => {
    const ways = [way(1000, "highway=track")];
    expect(surfacesAlong(ways, [0, 0, 0])).toEqual(["unpaved", "unpaved", "unpaved"]);
  });
});

describe("surfaceShares", () => {
  it("splits a ride by whatever it is weighted with", () => {
    const surfaces: Surface[] = ["paved", "paved", "unpaved", "unpaved"];
    const shares = surfaceShares(surfaces, [0, 1, 2, 3]);
    expect(shares.paved).toBeCloseTo(1, 9);
    expect(shares.unpaved).toBeCloseTo(2, 9);
    expect(shares.unknown).toBe(0);
  });
});
