import { readFileSync } from "node:fs";
import type { Corpus, Entry, Lang } from "../types.ts";
import { norm } from "../util/text.ts";

const LANG_HEADER = /^([a-z]{2})(?:[-_]([A-Za-z]{2,4}))?$/;

export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") { quoted = true; continue; }
    if (c === delimiter) { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export function sniffDelimiter(head: string): string {
  const line = head.split(/\r?\n/)[0] ?? "";
  const counts = [";", ",", "\t", "|"].map((d) => [d, line.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

export function decodeBuffer(buf: Buffer): { text: string; encoding: string; lossy: number } {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const replacements = (utf8.match(/�/g) ?? []).length;
  let text = utf8;
  let encoding = "utf-8";
  if (replacements > 0) {
    text = new TextDecoder("windows-1250", { fatal: false }).decode(buf);
    encoding = "windows-1250";
  }
  const lossy = (text.match(/\p{L}\?|\?\p{L}/gu) ?? []).length;
  return { text, encoding, lossy };
}

export type CsvOptions = {
  path: string;
  sourceLang: Lang;
  keyColumn?: string;
  langColumns?: Record<Lang, string>;
  project?: string;
};

export type CsvLoad = { corpus: Corpus; encoding: string; lossy: number };

export function loadFromCsv(opts: CsvOptions): CsvLoad {
  const buf = readFileSync(opts.path);
  const { text, encoding, lossy } = decodeBuffer(buf);
  const rows = parseDelimited(text, sniffDelimiter(text));
  if (rows.length < 2) throw new Error(`${opts.path}: need a header row and at least one data row`);

  const header = rows[0].map((h) => h.trim());
  const body = rows.slice(1);
  const project = opts.project ?? opts.path.split("/").pop()!.replace(/\.[^.]+$/, "");

  const langCol: Record<Lang, number> = {};
  if (opts.langColumns) {
    for (const [lang, col] of Object.entries(opts.langColumns)) {
      const i = header.findIndex((h) => h.toLowerCase() === col.toLowerCase());
      if (i < 0) throw new Error(`${opts.path}: no column "${col}" for language ${lang}`);
      langCol[lang] = i;
    }
  } else {
    header.forEach((h, i) => {
      const m = LANG_HEADER.exec(h.trim().toLowerCase());
      if (m) langCol[m[1]] = i;
    });
  }

  const keyIdx = opts.keyColumn
    ? header.findIndex((h) => h.toLowerCase() === opts.keyColumn!.toLowerCase())
    : header.findIndex((h) => /^(key|key ?name|id|code|identifier)$/i.test(h.trim()));

  if (Object.keys(langCol).length >= 2) {
    const langs = Object.keys(langCol).sort();
    const entries: Entry[] = body.map((r, n) => {
      const tr: Record<Lang, string> = {};
      for (const [lang, i] of Object.entries(langCol)) tr[lang] = r[i] ?? "";
      const keyName = keyIdx >= 0 ? (r[keyIdx] ?? "") : `row-${n + 2}`;
      return {
        id: `${project}:${keyIdx >= 0 ? keyName : n + 2}`,
        project,
        keyName,
        source: norm(tr[opts.sourceLang] ?? keyName),
        description: "",
        context: "",
        tags: [],
        tr,
        status: {},
      };
    });
    return {
      corpus: { sourceLang: opts.sourceLang, langs, entries, origin: `${opts.path} (${encoding}, ${entries.length} rows)` },
      encoding,
      lossy,
    };
  }

  const pick = (...names: string[]) => header.findIndex((h) => names.some((n) => h.toLowerCase().includes(n)));
  const srcIdx = pick("_pl", "source", "term", "nazwa");
  const tgtIdx = pick("_en", "target", "translation", "category");
  const altIdx = pick("alternative", "alt");
  const noteIdx = pick("note", "uwag", "review");
  if (srcIdx < 0 || tgtIdx < 0) {
    throw new Error(
      `${opts.path}: could not infer columns from header [${header.join(", ")}]. ` +
        `Pass --key-column and --lang-column <iso>=<header>.`,
    );
  }
  const target = Object.keys(langCol)[0] ?? "en";
  const entries: Entry[] = body.map((r, n) => ({
    id: `${project}:${keyIdx >= 0 ? r[keyIdx] : n + 2}`,
    project,
    keyName: keyIdx >= 0 ? (r[keyIdx] ?? "") : `row-${n + 2}`,
    source: norm(r[srcIdx] ?? ""),
    description: altIdx >= 0 ? `alternative: ${norm(r[altIdx] ?? "")}` : "",
    context: noteIdx >= 0 ? norm(r[noteIdx] ?? "") : "",
    tags: [],
    tr: { [opts.sourceLang]: norm(r[srcIdx] ?? ""), [target]: norm(r[tgtIdx] ?? "") },
    status: {},
  }));
  return {
    corpus: {
      sourceLang: opts.sourceLang,
      langs: [opts.sourceLang, target],
      entries,
      origin: `${opts.path} (${encoding}, ${entries.length} rows, review-sheet layout)`,
    },
    encoding,
    lossy,
  };
}
