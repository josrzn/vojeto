declare module "yauzl-promise" {
  import type { Readable } from "node:stream";

  export interface Entry {
    filename: string;
    uncompressedSize: number;
    openReadStream(): Promise<Readable>;
  }

  export interface Zip extends AsyncIterable<Entry> {
    close(): Promise<void>;
  }

  export function open(path: string, options?: Record<string, unknown>): Promise<Zip>;
}
