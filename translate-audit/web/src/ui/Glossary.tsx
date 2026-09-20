import { useCallback, useEffect, useState } from "react";
import { Grid, Meter, type Column } from "./Grid.tsx";
import { api } from "../lib/api.ts";
import type { GlossaryRow, TermOpinion, TermStatus } from "../lib/wire.ts";

const COLUMNS: Column[] = [
  { key: "term", label: "Source term", width: "minmax(150px, 1fr)" },
  { key: "lang", label: "Lang", width: "56px" },
  { key: "canonical", label: "Canonical", width: "minmax(170px, 1.1fr)" },
  { key: "variants", label: "Renderings in use", width: "minmax(220px, 1.4fr)" },
  { key: "keys", label: "Keys", width: "64px" },
  { key: "status", label: "Status", width: "132px" },
  { key: "who", label: "Decided by", width: "110px" },
];

const STATUS_BUTTONS: { status: TermStatus; label: string; hint: string }[] = [
  { status: "approved", label: "Approved", hint: "This is the word. Enforce it everywhere." },
  { status: "context-dependent", label: "Depends on context", hint: "No single right rendering — stop flagging these." },
  { status: "do-not-translate", label: "Do not translate", hint: "A brand or model name. Keep it as it is." },
  { status: "rejected", label: "None of these", hint: "Every rendering in the corpus is wrong; the right word is not here yet." },
];

type Props = {
  rows: GlossaryRow[];
  total: number;
  loadMore: () => void;
  onChanged: () => void;
  langs: string[];
  live: boolean;
  toast: (msg: string, err?: boolean) => void;
};

export function Glossary({ rows, total, loadMore, onChanged, langs, live, toast }: Props) {
  const [sel, setSel] = useState(0);
  const [canonical, setCanonical] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<string | null>(null);
  const [opinion, setOpinion] = useState<TermOpinion | null>(null);
  const [asking, setAsking] = useState(false);
  const [adding, setAdding] = useState({ term: "", lang: langs[0] ?? "de", canonical: "" });

  const row = rows[Math.min(sel, rows.length - 1)] as GlossaryRow | undefined;

  useEffect(() => {
    setCanonical(null);
    setGuidance(null);
    setOpinion(null);
    setAsking(false);
  }, [row?.key]);

  const patch = useCallback(
    async (p: { canonical?: string | null; status?: TermStatus; guidance?: string }) => {
      if (!row) return;
      try {
        await api.patchTerm(row.key, p);
        setCanonical(null);
        setGuidance(null);
        onChanged();
      } catch (e) {
        toast((e as Error).message, true);
      }
    },
    [row, onChanged, toast],
  );

  const ask = useCallback(async () => {
    if (!row) return;
    setAsking(true);
    try {
      setOpinion(await api.askAbout(row.key));
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setAsking(false);
    }
  }, [row, toast]);

  const add = useCallback(async () => {
    if (!adding.term.trim() || !adding.canonical.trim()) return;
    try {
      await api.addTerm(adding);
      setAdding({ term: "", lang: adding.lang, canonical: "" });
      onChanged();
      toast(`added "${adding.term}" → "${adding.canonical}"`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  }, [adding, onChanged, toast]);

  return (
    <div className="split">
      <Grid
        columns={COLUMNS}
        rows={rows}
        total={total}
        selected={sel}
        onSelect={setSel}
        onNeedMore={loadMore}
        rowKey={(r) => r.key}
        rowClass={(r) => (r.decidedAt ? "done" : "")}
        empty="No terms yet. Run an audit, or add one below."
        renderRow={(r) => (
          <>
            <div title={r.display}>{r.display}</div>
            <div className="mono">{r.lang}</div>
            <div className={r.canonical ? "" : "dim"} title={r.canonical ?? ""}>
              {r.canonical ?? "—"}
            </div>
            <div className="dim" title={r.variants.map((v) => `${v.text} (${v.count})`).join("  |  ")}>
              {r.variants.map((v) => v.text).join("  ·  ")}
            </div>
            <div style={{ textAlign: "right" }}>{r.entryIds.length}</div>
            <div className={r.status === "proposed" ? "dim" : "ok"}>{r.status}</div>
            <div className="dim">{r.decidedBy ?? ""}</div>
          </>
        )}
      />

      {row && (
        <div className="gpanel">
          <div className="pad" style={{ padding: "12px 16px 14px", display: "grid", gap: 10 }}>
            <div className="crumb">
              <b style={{ fontSize: 14 }}>{row.display}</b>
              <span>→</span>
              <span className="mono">{row.lang}</span>
              <span>·</span>
              <span>{row.entryIds.length} keys affected</span>
              {!Number.isNaN(row.severity) && <Meter label="damage if inconsistent" value={row.severity / 3} />}
              {row.source === "code" && <span className="chip">resolved in code — spacing only</span>}
              {Number.isFinite(row.covered) && row.covered < 0.5 && (
                <span
                  className="chip off"
                  title="A Choice always has to point at something, so it reports which option won, not whether the winner is any good. This is the separate question that can say the list itself is wrong."
                >
                  none of these may be right ({row.covered.toFixed(2)})
                </span>
              )}
              {row.decidedBy && (
                <span className="chip">
                  {row.status} by {row.decidedBy}
                </span>
              )}
            </div>

            <div className="pair">
              <label>Renderings</label>
              <div className="variants">
                {row.variants.map((v) => {
                  const p = opinion?.probabilities[v.text];
                  return (
                    <button
                      key={v.text}
                      className={`variant ${row.canonical === v.text ? "pick" : ""}`}
                      onClick={() => void patch({ canonical: v.text, status: "approved" })}
                      title="Make this the canonical term"
                    >
                      {v.text}
                      <span className="n">×{v.count}</span>
                      {p !== undefined && <span className="p">{Math.round(p * 100)}%</span>}
                    </button>
                  );
                })}
                {row.variants.length === 0 && <span className="dim">Added by hand — no observed renderings.</span>}
              </div>
            </div>

            {Number.isFinite(row.covered) && row.covered < 0.5 && (
              <div className="pair">
                <label />
                <div className="dim" style={{ fontSize: 12 }}>
                  Every rendering above may be wrong. Type the correct term below, or mark{" "}
                  <b>None of these</b> — the confidence on the chosen option would not have told
                  you this, because a Choice reports which option beat the others, not whether
                  the winner is any good.
                </div>
              </div>
            )}

            <div className="pair">
              <label>Or type one</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  value={canonical ?? row.canonical ?? ""}
                  onChange={(e) => setCanonical(e.target.value)}
                  placeholder="the word that should be used everywhere"
                  onKeyDown={(e) => {
                    const typed = (canonical ?? "").trim();
                    if (e.key === "Enter" && typed) void patch({ canonical: typed, status: "approved" });
                  }}
                />
                <button
                  className="btn"
                  disabled={canonical === null || !canonical.trim()}
                  onClick={() => void patch({ canonical: (canonical ?? "").trim(), status: "approved" })}
                >
                  Set
                </button>
              </div>
            </div>

            <div className="pair">
              <label>Decision</label>
              <div className="statusrow">
                {STATUS_BUTTONS.map((b) => (
                  <button
                    key={b.status}
                    className={`sbtn ${row.status === b.status ? "on" : ""}`}
                    title={b.hint}
                    onClick={() => void patch({ status: b.status })}
                  >
                    {b.label}
                  </button>
                ))}
                {live && (
                  <button className="sbtn" onClick={() => void ask()} disabled={asking} title="One request to Jev about this term">
                    {asking ? "asking…" : "What does Jev think?"}
                  </button>
                )}
              </div>
            </div>

            {opinion && (
              <div className="pair">
                <label>Jev says</label>
                <div className="actions">
                  {opinion.contextDependent ? (
                    <span className="chip">no single rendering fits</span>
                  ) : (
                    <span className="chip">
                      <b>{opinion.canonical}</b>
                    </span>
                  )}
                  <Meter label="confidence" value={opinion.confidence} />
                  {!Number.isNaN(opinion.doNotTranslate) && <Meter label="is a brand name" value={opinion.doNotTranslate} />}
                  <span className="chip">{opinion.ms} ms</span>
                </div>
              </div>
            )}

            <div className="pair">
              <label>Rule for Jev</label>
              <div>
                <textarea
                  value={guidance ?? row.guidance}
                  onChange={(e) => setGuidance(e.target.value)}
                  onBlur={() => guidance !== null && guidance !== row.guidance && void patch({ guidance })}
                  placeholder='In your own words, e.g. "Tor when it is a gate in a fence; Tür when it is a garage door." Sent to Jev on the next audit, so it reaches strings nobody has opened.'
                />
              </div>
            </div>
          </div>

          <div className="pad" style={{ padding: "0 16px 14px", borderTop: "1px solid var(--line)" }}>
            <div className="pair" style={{ paddingTop: 12 }}>
              <label>Add a term</label>
              <div className="addbar">
                <input
                  type="text"
                  placeholder="source term (pl)"
                  value={adding.term}
                  onChange={(e) => setAdding({ ...adding, term: e.target.value })}
                />
                <select value={adding.lang} onChange={(e) => setAdding({ ...adding, lang: e.target.value })}>
                  {langs.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="must always be translated as…"
                  value={adding.canonical}
                  onChange={(e) => setAdding({ ...adding, canonical: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && void add()}
                />
                <button className="btn" disabled={!adding.term.trim() || !adding.canonical.trim()} onClick={() => void add()}>
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
