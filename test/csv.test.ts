import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { at, columnIndex, parseCsv } from "../src/gtfs/csv.js";

async function collect(text: string, chunkSize = 1024): Promise<string[][]> {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));
  const rows: string[][] = [];
  for await (const row of parseCsv(Readable.from(chunks.length ? chunks : [""]))) rows.push(row);
  return rows;
}

describe("parseCsv", () => {
  it("parses a plain table", async () => {
    expect(await collect("a,b,c\n1,2,3\n4,5,6\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("accepts a final record with no trailing newline", async () => {
    expect(await collect("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles CRLF and a UTF-8 BOM", async () => {
    expect(await collect("﻿a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields containing commas, quotes and newlines", async () => {
    const rows = await collect('a,b\n"x,y","he said ""hi"""\n"multi\nline",z\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x,y", 'he said "hi"'],
      ["multi\nline", "z"],
    ]);
  });

  it("keeps empty fields but drops blank lines", async () => {
    expect(await collect("a,b,c\n1,,3\n\n4,5,\n")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
      ["4", "5", ""],
    ]);
  });

  it("produces the same rows no matter where chunk boundaries fall", async () => {
    const text = 'id,name,note\n1,"Roanne, Loire","a ""quoted"" bit"\n2,Lyon,\n3,"multi\nline",x\n';
    const expected = await collect(text, 4096);
    for (const size of [1, 2, 3, 5, 7, 13, 29]) {
      expect(await collect(text, size), `chunk size ${size}`).toEqual(expected);
    }
  });

  it("looks up columns by name and tolerates missing ones", async () => {
    const header = ["trip_id", "arrival_time", "stop_id"];
    const [trip, departure, stop] = columnIndex(header, "trip_id", "departure_time", "stop_id");
    expect([trip, departure, stop]).toEqual([0, -1, 2]);
    const row = ["T1", "07:42:00", "S9"];
    expect(at(row, trip!)).toBe("T1");
    expect(at(row, departure!)).toBe("");
    expect(at(row, stop!)).toBe("S9");
  });
});
