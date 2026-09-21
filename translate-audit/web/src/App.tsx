import { useCallback, useEffect, useRef, useState } from "react";
import { Review } from "./ui/Review.tsx";
import { Glossary } from "./ui/Glossary.tsx";
import { Summary } from "./ui/Summary.tsx";
import { Check } from "./ui/Check.tsx";
import { api, getWho, setWho } from "./lib/api.ts";
import { CATEGORIES, STATUSES, type GlossaryRow, type Meta, type ReviewRow, type Stats } from "./lib/wire.ts";

const PAGE = 200;
type Sheet = "review" | "glossary" | "check" | "summary";

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [sheet, setSheet] = useState<Sheet>("review");
  const [who, setWhoState] = useState(getWho());
  const [toast, setToastState] = useState<{ msg: string; err: boolean } | null>(null);

  const [lang, setLang] = useState("");
  const [category, setCategory] = useState("");
  const [minSeverity, setMinSeverity] = useState(2);
  const [undecidedOnly, setUndecidedOnly] = useState(true);
  const [q, setQ] = useState("");

  const [gLang, setGLang] = useState("");
  const [gStatus, setGStatus] = useState("");
  const [gQ, setGQ] = useState("");

  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [rowTotal, setRowTotal] = useState(0);
  const [gRows, setGRows] = useState<GlossaryRow[]>([]);
  const [gTotal, setGTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = useCallback((msg: string, err = false) => {
    setToastState({ msg, err });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastState(null), err ? 5000 : 2200);
  }, []);

  useEffect(() => {
    api.meta().then(setMeta).catch((e: Error) => setError(e.message));
  }, []);

  const refreshStats = useCallback(() => {
    api.stats().then(setStats).catch(() => undefined);
  }, []);
  useEffect(refreshStats, [refreshStats]);

  const loadRows = useCallback(
    async (offset = 0) => {
      const r = await api.rows({
        lang,
        category,
        minSeverity,
        undecidedOnly: undecidedOnly ? "1" : undefined,
        q,
        offset,
        limit: PAGE,
      });
      setRowTotal(r.total);
      setRows((prev) => (offset === 0 ? r.rows : [...prev, ...r.rows]));
    },
    [lang, category, minSeverity, undecidedOnly, q],
  );

  const loadGlossary = useCallback(
    async (offset = 0) => {
      const r = await api.glossary({ lang: gLang, status: gStatus, q: gQ, offset, limit: PAGE });
      setGTotal(r.total);
      setGRows((prev) => (offset === 0 ? r.rows : [...prev, ...r.rows]));
    },
    [gLang, gStatus, gQ],
  );

  useEffect(() => {
    void loadRows(0).catch((e: Error) => setError(e.message));
  }, [loadRows]);

  useEffect(() => {
    void loadGlossary(0).catch((e: Error) => setError(e.message));
  }, [loadGlossary]);

  const afterChange = useCallback(() => {
    refreshStats();
    void loadRows(0);
    void loadGlossary(0);
  }, [refreshStats, loadRows, loadGlossary]);

  if (error) {
    return (
      <div className="empty" style={{ paddingTop: 80 }}>
        <p className="bad">{error}</p>
        <p className="dim">Is the review server running? Start it with `npm run review`.</p>
      </div>
    );
  }
  if (!meta || !stats) return <div className="empty" style={{ paddingTop: 80 }}>Loading…</div>;

  const reviewed = stats.decisions.total;
  const queue = stats.summary.findings;

  return (
    <div className="app">
      <header className="titlebar">
        <div className="logo">T</div>
        <div className="titleblock">
          <div className="doctitle">Translation review</div>
          <div className="subtitle">
            {meta.origin} · {meta.keys.toLocaleString()} keys · {meta.langs.join(", ")} · judgments from{" "}
            {meta.savedAt.slice(0, 16).replace("T", " ")}
          </div>
        </div>
        <span className={`chip ${meta.live ? "live" : "off"}`}>
          {meta.live ? "Jev live — edits are checked" : "No API key — live checks off"}
        </span>
        <div className="who">
          <span className="dim">you</span>
          <input
            value={who}
            placeholder="your name"
            onChange={(e) => {
              setWhoState(e.target.value);
              setWho(e.target.value);
            }}
          />
        </div>
      </header>

      <nav className="toolbar">
        <div className="tabs">
          <button className={`tab ${sheet === "review" ? "on" : ""}`} onClick={() => setSheet("review")}>
            Review <span className="n">{rowTotal.toLocaleString()}</span>
          </button>
          <button className={`tab ${sheet === "glossary" ? "on" : ""}`} onClick={() => setSheet("glossary")}>
            Glossary <span className="n">{stats.glossary.decided}/{stats.glossary.total}</span>
          </button>
          <button
            className={`tab ${sheet === "check" ? "on" : ""}`}
            onClick={() => setSheet("check")}
            title="Check a string you are writing — the glossary half costs nothing"
          >
            Check a string
          </button>
          <button className={`tab ${sheet === "summary" ? "on" : ""}`} onClick={() => setSheet("summary")}>
            Summary
          </button>
        </div>
        <div className="sep" />

        {sheet === "review" && (
          <>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="">all languages</option>
              {meta.langs.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">all kinds</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select value={minSeverity} onChange={(e) => setMinSeverity(Number(e.target.value))}>
              <option value={0}>any severity</option>
              <option value={1}>1+ minor</option>
              <option value={2}>2+ confusing</option>
              <option value={3}>3 breaks meaning</option>
            </select>
            <button className={`toggle ${undecidedOnly ? "on" : ""}`} onClick={() => setUndecidedOnly((v) => !v)}>
              {undecidedOnly ? "unreviewed only" : "everything"}
            </button>
            <input type="search" placeholder="search…" value={q} onChange={(e) => setQ(e.target.value)} />
          </>
        )}

        {sheet === "glossary" && (
          <>
            <select value={gLang} onChange={(e) => setGLang(e.target.value)}>
              <option value="">all languages</option>
              {meta.langs.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <select value={gStatus} onChange={(e) => setGStatus(e.target.value)}>
              <option value="">any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <input type="search" placeholder="search terms…" value={gQ} onChange={(e) => setGQ(e.target.value)} />
          </>
        )}

        <span className="grow" />
        <a className="btn ghost" href="/api/export.csv" download>
          Export {stats.decisions.changed} changes
        </a>
      </nav>

      <div className="body">
        {sheet === "review" && (
          <Review
            rows={rows}
            total={rowTotal}
            loadMore={() => void loadRows(rows.length)}
            onDecided={afterChange}
            keepsDecidedRows={!undecidedOnly}
            live={meta.live}
            toast={showToast}
          />
        )}
        {sheet === "glossary" && (
          <Glossary
            rows={gRows}
            total={gTotal}
            loadMore={() => void loadGlossary(gRows.length)}
            onChanged={afterChange}
            langs={meta.langs}
            live={meta.live}
            toast={showToast}
          />
        )}
        {sheet === "check" && (
          <Check langs={meta.langs} sourceLang={meta.sourceLang} live={meta.live} toast={showToast} />
        )}
        {sheet === "summary" && <Summary meta={meta} stats={stats} />}
      </div>

      <footer className="statusbar">
        <span>
          {reviewed.toLocaleString()} reviewed · {stats.decisions.changed.toLocaleString()} will change
        </span>
        <span className="prog">
          <i style={{ width: `${Math.min(100, (100 * reviewed) / Math.max(1, reviewed + queue))}%` }} />
        </span>
        <span>{queue.toLocaleString()} findings in the queue</span>
        <span className="grow" />
        {stats.glossary.total > 0 && (
          <span>
            glossary {stats.glossary.decided}/{stats.glossary.total} decided
            {stats.glossary.withGuidance > 0 && ` · ${stats.glossary.withGuidance} with a rule`}
          </span>
        )}
      </footer>

      {toast && <div className={`toast ${toast.err ? "err" : ""}`}>{toast.msg}</div>}
    </div>
  );
}
