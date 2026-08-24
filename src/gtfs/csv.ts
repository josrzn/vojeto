import type { Readable } from "node:stream";

const COMMA = 44;
const QUOTE = 34;
const CR = 13;
const LF = 10;

/**
 * Parses one record starting at `start`.
 *
 * Returns null when the buffer does not yet hold a complete record, so the
 * caller can append the next chunk and retry. Pass `final` once the stream has
 * ended, to accept a last record with no trailing newline.
 */
function parseRecord(
  text: string,
  start: number,
  final: boolean,
): { row: string[]; next: number } | null {
  if (start >= text.length) return null;
  const row: string[] = [];
  let i = start;

  for (;;) {
    if (text.charCodeAt(i) === QUOTE) {
      let value = "";
      i++;
      let segment = i;
      for (;;) {
        const close = text.indexOf('"', i);
        if (close === -1) return null;
        if (text.charCodeAt(close + 1) === QUOTE) {
          // "" is an escaped quote: keep one and carry on inside the field.
          value += text.slice(segment, close + 1);
          i = close + 2;
          segment = i;
        } else {
          value += text.slice(segment, close);
          i = close + 1;
          break;
        }
      }
      row.push(value);
    } else {
      let j = i;
      while (j < text.length) {
        const c = text.charCodeAt(j);
        if (c === COMMA || c === LF || c === CR) break;
        j++;
      }
      // Running out of buffer mid-field means the field may continue.
      if (j >= text.length && !final) return null;
      row.push(text.slice(i, j));
      i = j;
    }

    if (i >= text.length) return final ? { row, next: i } : null;

    const c = text.charCodeAt(i);
    if (c === COMMA) {
      i++;
      continue;
    }
    if (c === CR) {
      i++;
      if (text.charCodeAt(i) === LF) i++;
      return { row, next: i };
    }
    if (c === LF) return { row, next: i + 1 };
    // A stray character after a closing quote; treat the record as unterminated.
    return null;
  }
}

/**
 * Streaming RFC 4180 parser. Yields raw string[] rows rather than objects
 * because stop_times.txt in the SNCF feed runs to millions of rows and an
 * object per row dominates ingest time.
 *
 * The first row yielded is the header.
 */
export async function* parseCsv(stream: Readable): AsyncGenerator<string[]> {
  let buffer = "";
  let sawBom = false;

  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (!sawBom) {
      if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
      sawBom = true;
    }

    let pos = 0;
    for (;;) {
      const record = parseRecord(buffer, pos, false);
      if (!record) break;
      pos = record.next;
      if (record.row.length > 1 || record.row[0] !== "") yield record.row;
    }
    if (pos > 0) buffer = buffer.slice(pos);
  }

  let pos = 0;
  for (;;) {
    const record = parseRecord(buffer, pos, true);
    if (!record) break;
    pos = record.next;
    if (record.row.length > 1 || record.row[0] !== "") yield record.row;
  }
}

/** Maps the column names you care about to their index, or -1 when absent. */
export function columnIndex(header: string[], ...names: string[]): number[] {
  const lookup = new Map(header.map((h, i) => [h.trim(), i]));
  return names.map((n) => lookup.get(n) ?? -1);
}

/** Reads a column that may be missing from the file, returning "" instead of undefined. */
export function at(row: string[], index: number): string {
  return index < 0 ? "" : (row[index] ?? "");
}
