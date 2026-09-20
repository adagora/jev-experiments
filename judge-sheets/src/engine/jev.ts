/**
 * Pure (no network) description of a Jev judgment and the cache the engine
 * reads from. The batcher in src/lib fills the cache; the engine only reads it.
 */
import type { JevKind, JevValue, ErrorValue } from "./values.ts";

export type JevSpec = {
  kind: JevKind;
  /** The state sent to Jev: the cell text being judged. */
  text: string;
  instructions: string;
  /** PICK options / RATE levels; empty for JUDGE. */
  options: string[];
};

export const jevKey = (s: JevSpec): string => JSON.stringify([s.kind, s.text, s.instructions, s.options]);

export const splitOptions = (s: string): string[] =>
  s
    .split("|")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

export class JevCache {
  private map = new Map<string, JevValue | ErrorValue>();
  get size(): number {
    return this.map.size;
  }
  get(key: string): JevValue | ErrorValue | undefined {
    return this.map.get(key);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  set(key: string, v: JevValue | ErrorValue): void {
    this.map.set(key, v);
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

/**
 * Group pending specs so that every distinct source text becomes ONE request
 * carrying all of its questions (fan-out over one state).
 */
export type JevBatch = { text: string; specs: JevSpec[] };

export function batchSpecs(specs: Iterable<JevSpec>): JevBatch[] {
  const byText = new Map<string, JevSpec[]>();
  for (const s of specs) {
    const list = byText.get(s.text);
    if (list) list.push(s);
    else byText.set(s.text, [s]);
  }
  return [...byText.entries()].map(([text, list]) => ({ text, specs: list }));
}
