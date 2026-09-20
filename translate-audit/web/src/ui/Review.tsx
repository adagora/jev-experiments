import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Grid, Meter, SEV_DOT, type Column } from "./Grid.tsx";
import { api } from "../lib/api.ts";
import type { EditCheck, ReviewRow, Verdict } from "../lib/wire.ts";
import { SEVERITY_LABEL } from "../lib/wire.ts";

const COLUMNS: Column[] = [
  { key: "sev", label: "Sev", width: "52px" },
  { key: "cat", label: "Kind", width: "110px" },
  { key: "lang", label: "Lang", width: "56px" },
  { key: "source", label: "Source (pl)", width: "minmax(220px, 1.2fr)" },
  { key: "current", label: "Current translation", width: "minmax(220px, 1.2fr)" },
  { key: "suggested", label: "Suggested", width: "minmax(180px, 1fr)" },
  { key: "why", label: "Why", width: "minmax(220px, 1.1fr)" },
  { key: "verdict", label: "You", width: "80px" },
];

type Props = {
  rows: ReviewRow[];
  total: number;
  loadMore: () => void;
  onDecided: () => void;
  keepsDecidedRows: boolean;
  live: boolean;
  toast: (msg: string, err?: boolean) => void;
};

export function Review({ rows, total, loadMore, onDecided, keepsDecidedRows, live, toast }: Props) {
  const [sel, setSel] = useState(0);
  const [draft, setDraft] = useState<string | null>(null);
  const [check, setCheck] = useState<EditCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const checkSeq = useRef(0);

  const row = rows[Math.min(sel, rows.length - 1)] as ReviewRow | undefined;
  const rowId = row ? `${row.entryId}\u0000${row.lang}` : "";

  useEffect(() => {
    setDraft(null);
    setCheck(null);
    setChecking(false);
    checkSeq.current++;
  }, [rowId]);

  const value = draft ?? row?.decidedText ?? row?.current ?? "";

  useEffect(() => {
    if (!live || draft === null || !row) return;
    const text = draft.trim();
    if (!text || text === row.current.trim()) {
      setCheck(null);
      return;
    }
    const seq = ++checkSeq.current;
    setChecking(true);
    const t = setTimeout(() => {
      api
        .check({ entryId: row.entryId, lang: row.lang, text })
        .then((r) => {
          if (seq === checkSeq.current) setCheck(r);
        })
        .catch(() => {
          if (seq === checkSeq.current) setCheck(null);
        })
        .finally(() => {
          if (seq === checkSeq.current) setChecking(false);
        });
    }, 450);
    return () => clearTimeout(t);
  }, [draft, live, row]);

  const decide = useCallback(
    async (verdict: Verdict, text?: string) => {
      if (!row) return;
      try {
        await api.decide({
          entryId: row.entryId,
          lang: row.lang,
          verdict,
          text,
          check: verdict === "edited" ? check : null,
        });
        setDraft(null);
        setCheck(null);
        onDecided();
        if (keepsDecidedRows) setSel((s) => Math.min(s + 1, rows.length - 1));
      } catch (e) {
        toast((e as Error).message, true);
      }
    },
    [row, check, onDecided, rows.length, keepsDecidedRows, toast],
  );

  const undo = useCallback(async () => {
    if (!row) return;
    await api.undecide(row.entryId, row.lang);
    setDraft(null);
    onDecided();
  }, [row, onDecided]);

  const save = useCallback(() => {
    if (!row || draft === null) return;
    void decide(draft.trim() === row.current.trim() ? "defer" : "edited", draft);
  }, [row, draft, decide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inEditor = document.activeElement === areaRef.current;
      if (inEditor) {
        if (e.key === "Escape") {
          setDraft(null);
          areaRef.current?.blur();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          save();
        }
        return;
      }
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          setSel((s) => Math.min(s + 1, rows.length - 1));
          break;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          setSel((s) => Math.max(s - 1, 0));
          break;
        case "a":
          e.preventDefault();
          void decide("accept");
          break;
        case "r":
          e.preventDefault();
          void decide("reject");
          break;
        case "d":
          e.preventDefault();
          void decide("defer");
          break;
        case "u":
          e.preventDefault();
          void undo();
          break;
        case "Enter":
          e.preventDefault();
          areaRef.current?.focus();
          areaRef.current?.select();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows.length, decide, undo, save]);

  const columns = useMemo(() => COLUMNS, []);

  return (
    <div className="split">
      <Grid
        columns={columns}
        rows={rows}
        total={total}
        selected={sel}
        onSelect={setSel}
        onNeedMore={loadMore}
        rowKey={(r) => `${r.entryId}:${r.lang}`}
        rowClass={(r) => (r.verdict ? "done" : "")}
        empty="No findings match these filters — try widening them, or you are done."
        renderRow={(r) => (
          <>
            <div style={{ textAlign: "center" }}>
              <span className="sevdot" style={{ background: SEV_DOT[Math.min(3, Math.round(r.severity))] }} />
              {Math.min(3, Math.round(r.severity))}
            </div>
            <div>
              <span className={`cat ${r.category}`}>{r.category}</span>
            </div>
            <div className="mono">{r.lang}</div>
            <div title={r.source}>{r.source}</div>
            <div title={r.current}>{r.current || <span className="dim">— empty —</span>}</div>
            <div className={r.suggested ? "ok" : "dim"} title={r.suggested ?? ""}>
              {r.suggested ?? "—"}
            </div>
            <div className="dim" title={r.reasons.join("\n")}>
              {r.reasons[0] ?? ""}
            </div>
            <div className={`verdict ${r.verdict ?? ""}`}>{r.verdict ?? ""}</div>
          </>
        )}
      />

      {row && (
        <div className="editor">
          <div className="pad">
            <div className="crumb">
              <span className="sevdot" style={{ background: SEV_DOT[Math.min(3, Math.round(row.severity))] }} />
              <b>{SEVERITY_LABEL[Math.min(3, Math.round(row.severity))]}</b>
              <span className={`cat ${row.category}`}>{row.category}</span>
              <span>·</span>
              <span>{row.project}</span>
              <span className="key">{row.keyName}</span>
              <span>·</span>
              <span className="mono">{row.lang}</span>
              {row.decidedBy && <span className="chip">decided by {row.decidedBy}</span>}
            </div>

            <div className="pair">
              <label>Source (pl)</label>
              <div className="srcbox">{row.source}</div>
            </div>

            {row.suggested && (
              <div className="pair">
                <label>Suggested</label>
                <div>
                  <div className="sug">{row.suggested}</div>
                  {row.substitutionOk !== null && (
                    <div style={{ marginTop: 4 }}>
                      <Meter label="Jev checked this substitution" value={row.substitutionOk} />
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="pair">
              <label>Translation</label>
              <div>
                <textarea
                  ref={areaRef}
                  value={value}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck
                  lang={row.lang}
                  placeholder="Type the translation, or press A to take the suggestion"
                />
                <div className="actions" style={{ marginTop: 6 }}>
                  {checking && <span className="chip">checking…</span>}
                  {check && (
                    <>
                      <Meter label="means the same" value={check.meaning} />
                      <Meter label="good {lang}" value={check.grammatical} />
                      {!Number.isNaN(check.glossaryOk) && <Meter label="follows glossary" value={check.glossaryOk} />}
                      <span className="chip">{check.ms} ms</span>
                    </>
                  )}
                  {!live && draft !== null && <span className="chip off">no API key — live check off</span>}
                </div>
              </div>
            </div>

            {row.siblings.length > 1 && (
              <div className="pair">
                <label>Used elsewhere</label>
                <div className="sibs">
                  {row.siblings.map((s) => (
                    <button key={s.text} className="sib" onClick={() => setDraft(s.text)} title="Use this wording">
                      {s.text}
                      <span className="n">×{s.count}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="pair">
              <label>Why</label>
              <ul className="why">
                {row.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>

            <div className="actions">
              <button className="btn" onClick={() => void decide("accept", draft ?? undefined)}>
                {draft !== null && draft.trim() !== row.current.trim() ? "Save my wording" : "Accept"}
                <span className="key-hint">A</span>
              </button>
              <button className="btn ghost" onClick={() => void decide("reject")}>
                Keep as is<span className="key-hint">R</span>
              </button>
              <button className="btn ghost" onClick={() => void decide("defer")}>
                Later<span className="key-hint">D</span>
              </button>
              {row.verdict && (
                <button className="btn ghost" onClick={() => void undo()}>
                  Undo<span className="key-hint">U</span>
                </button>
              )}
              <span className="grow" />
              <span className="dim">
                j/k move · Enter edit · ⌘↵ save · Esc cancel
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
