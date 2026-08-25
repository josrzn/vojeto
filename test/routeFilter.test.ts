import { describe, expect, it } from "vitest";
import {
  diagnose,
  isRailType,
  keepRoute,
  routeLabel,
  type RouteFilter,
  type RouteInfo,
} from "../src/gtfs/routeFilter.js";

const route = (overrides: Partial<RouteInfo> = {}): RouteInfo => ({
  routeId: "R1",
  agencyName: "TER Auvergne-Rhone-Alpes",
  shortName: "",
  longName: "Roanne - Lyon Part-Dieu",
  description: "",
  routeType: "2",
  ...overrides,
});

const filter = (overrides: Partial<RouteFilter> = {}): RouteFilter => ({
  keepPatterns: [/\bTER\b/i],
  dropPatterns: [/TGV/i],
  ...overrides,
});

describe("isRailType", () => {
  it("accepts basic rail", () => {
    expect(isRailType("2")).toBe(true);
  });

  it("accepts the extended rail range, which real feeds use", () => {
    // 100 railway, 102 long distance, 106 regional, 117 all rail.
    for (const type of ["100", "101", "102", "106", "109", "117"]) {
      expect(isRailType(type), `route_type ${type}`).toBe(true);
    }
  });

  it("rejects road and other modes", () => {
    for (const type of ["3", "200", "700", "1100"]) {
      expect(isRailType(type), `route_type ${type}`).toBe(false);
    }
  });

  it("treats a missing value as rail, since this feed is a rail feed", () => {
    expect(isRailType("")).toBe(true);
    expect(isRailType("  ")).toBe(true);
  });

  it("rejects a non-numeric value", () => {
    expect(isRailType("rail")).toBe(false);
  });
});

describe("routeLabel", () => {
  it("joins the populated fields only", () => {
    expect(routeLabel(route({ shortName: "", description: "" }))).toBe(
      "TER Auvergne-Rhone-Alpes | Roanne - Lyon Part-Dieu",
    );
  });

  it("includes short name and description when present", () => {
    expect(routeLabel(route({ shortName: "12", description: "regional" }))).toBe(
      "TER Auvergne-Rhone-Alpes | 12 | Roanne - Lyon Part-Dieu | regional",
    );
  });
});

describe("keepRoute", () => {
  it("keeps a matching rail route", () => {
    expect(keepRoute(route(), filter())).toBe(true);
  });

  it("keeps a route that only declares an extended rail type", () => {
    // This is the case that silently emptied the whole feed before.
    expect(keepRoute(route({ routeType: "106" }), filter())).toBe(true);
  });

  it("drops a non-rail route even when the label matches", () => {
    expect(keepRoute(route({ routeType: "700", longName: "TER bus" }), filter())).toBe(false);
  });

  it("lets a drop pattern beat a keep pattern", () => {
    const tgv = route({ agencyName: "TGV INOUI", longName: "TER-like name" });
    expect(keepRoute(tgv, filter())).toBe(false);
  });

  it("drops a rail route whose label matches nothing", () => {
    expect(keepRoute(route({ agencyName: "Eurostar", longName: "Paris - London" }), filter())).toBe(
      false,
    );
  });

  it("keeps every rail route when no keep patterns are configured", () => {
    const open = filter({ keepPatterns: [] });
    expect(keepRoute(route({ agencyName: "Whatever" }), open)).toBe(true);
    expect(keepRoute(route({ agencyName: "TGV INOUI" }), open)).toBe(false);
  });

  it("uses keepTypes in place of the rail check when given", () => {
    const byType = filter({ keepPatterns: [], dropPatterns: [], keepTypes: [106] });
    expect(keepRoute(route({ routeType: "106" }), byType)).toBe(true);
    expect(keepRoute(route({ routeType: "102" }), byType)).toBe(false);
    expect(keepRoute(route({ routeType: "2" }), byType)).toBe(false);
  });
});

describe("diagnose", () => {
  it("says plainly when routes.txt yielded nothing", () => {
    expect(diagnose([], filter())).toMatch(/no rows at all/);
  });

  it("breaks the routes down by route_type with a rail verdict", () => {
    const report = diagnose(
      [
        route({ routeType: "102", agencyName: "TGV INOUI" }),
        route({ routeType: "106" }),
        route({ routeType: "106", longName: "Roanne - Vichy" }),
        route({ routeType: "700", agencyName: "Cars TER" }),
      ],
      filter(),
    );
    expect(report).toMatch(/4 routes read/);
    expect(report).toMatch(/route_type 106\s+2 routes, 2 kept\s+\(rail\)/);
    expect(report).toMatch(/route_type 102\s+1 routes, 0 kept\s+\(rail\)/);
    expect(report).toMatch(/route_type 700\s+1 routes, 0 kept\s+\(not rail\)/);
  });

  it("lists kept and dropped labels so the pattern can be corrected", () => {
    const report = diagnose([route(), route({ agencyName: "TGV INOUI" })], filter());
    expect(report).toMatch(/KEEP {2}TER Auvergne-Rhone-Alpes \| Roanne - Lyon Part-Dieu/);
    expect(report).toMatch(/drop {2}TGV INOUI \| Roanne - Lyon Part-Dieu/);
  });

  it("truncates a long list instead of printing hundreds of lines", () => {
    const many = Array.from({ length: 50 }, (_, i) => route({ longName: `Line ${i}` }));
    const report = diagnose(many, filter(), 10);
    expect(report).toMatch(/and 40 more/);
  });
});
