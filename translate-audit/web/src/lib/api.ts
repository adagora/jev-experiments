import type { Consistency, EditCheck, EntryDetail, GlossaryRow, Meta, ReviewRow, Stats, TermOpinion, TermStatus, Verdict } from "./wire.ts";

const WHO_KEY = "translate-audit.who";

export function getWho(): string {
  try {
    return localStorage.getItem(WHO_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setWho(name: string): void {
  try {
    localStorage.setItem(WHO_KEY, name);
  } catch {
  }
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== "") q.set(k, String(v));
  const res = await fetch(`/api/${path}${q.toString() ? `?${q}` : ""}`);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(body as object), who: getWho() || "anonymous" }),
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export type RowQuery = {
  lang?: string;
  category?: string;
  project?: string;
  minSeverity?: number;
  undecidedOnly?: string;
  q?: string;
  offset?: number;
  limit?: number;
};

export const api = {
  meta: () => get<Meta>("meta"),
  stats: () => get<Stats>("stats"),
  rows: (query: RowQuery) => get<{ total: number; rows: ReviewRow[] }>("rows", query),
  entry: (id: string) => get<EntryDetail>(`entry/${encodeURIComponent(id)}`),
  glossary: (query: { lang?: string; status?: string; q?: string; offset?: number; limit?: number }) =>
    get<{ total: number; rows: GlossaryRow[] }>("glossary", query),

  decide: (input: { entryId: string; lang: string; verdict: Verdict; text?: string; check?: EditCheck | null }) =>
    post<{ decision: unknown; stats: Stats }>("decision", input),
  undecide: (entryId: string, lang: string) => post<{ stats: Stats }>("decision/clear", { entryId, lang }),

  patchTerm: (key: string, patch: { canonical?: string | null; status?: TermStatus; guidance?: string; note?: string }) =>
    post<{ term: GlossaryRow; stats: Stats }>(`glossary/${encodeURIComponent(key)}`, patch),
  addTerm: (input: { term: string; lang: string; canonical: string; guidance?: string }) =>
    post<{ term: GlossaryRow; stats: Stats }>("glossary", input),

  check: (input: { entryId: string; lang: string; text: string }) => post<EditCheck>("check", input),
  /** `semantic: false` asks only for the half that is a fact, which is free and keyless. */
  consistency: (input: { source: string; lang: string; text: string; note?: string; semantic?: boolean }) =>
    post<Consistency>("consistency", input),
  askAbout: (key: string) => post<TermOpinion>(`arbitrate/${encodeURIComponent(key)}`, {}),
};
