import { describe, expect, it } from "vitest";
import { parsePoint } from "../src/shared/geo.js";

describe("parsePoint", () => {
  it("reads the DMS form a mapping app produces", () => {
    const point = parsePoint("46°02'03.80\"N 4°04'45.63\"E");
    expect(point.lat).toBeCloseTo(46.034389, 5);
    expect(point.lon).toBeCloseTo(4.079342, 5);
  });

  it("reads decimal degrees", () => {
    expect(parsePoint("46.034389, 4.079342")).toEqual({ lat: 46.034389, lon: 4.079342 });
    expect(parsePoint("46.034389 4.079342")).toEqual({ lat: 46.034389, lon: 4.079342 });
    expect(parsePoint(" -1.5 ; 2.25 ")).toEqual({ lat: -1.5, lon: 2.25 });
  });

  it("honours southern and western hemispheres", () => {
    const point = parsePoint("33°52'04\"S 151°12'36\"E");
    expect(point.lat).toBeCloseTo(-33.867778, 5);
    expect(point.lon).toBeCloseTo(151.21, 5);
  });

  it("uses the hemisphere letters rather than the order when longitude comes first", () => {
    const point = parsePoint("4°04'45.63\"E 46°02'03.80\"N");
    expect(point.lat).toBeCloseTo(46.034389, 5);
    expect(point.lon).toBeCloseTo(4.079342, 5);
  });

  it("accepts degrees with no minutes or seconds", () => {
    expect(parsePoint("46°N 4°E").lat).toBeCloseTo(46, 6);
  });

  it("rejects values that are not coordinates", () => {
    expect(() => parsePoint("Roanne")).toThrow(/Cannot read/);
    expect(() => parsePoint("")).toThrow(/Cannot read/);
  });

  it("rejects coordinates outside the globe", () => {
    expect(() => parsePoint("120.0, 4.0")).toThrow(/Latitude out of range/);
    expect(() => parsePoint("46.0, 200.0")).toThrow(/Longitude out of range/);
  });
});
