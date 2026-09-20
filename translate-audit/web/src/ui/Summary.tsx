import type { Meta, Stats } from "../lib/wire.ts";
import { CATEGORY_NOTE, SEVERITY_LABEL } from "../lib/wire.ts";

const pct = (n: number, d: number) => (d === 0 ? "0%" : `${Math.round((100 * n) / d)}%`);

export function Summary({ meta, stats }: { meta: Meta; stats: Stats }) {
  const s = stats.summary;
  const requests = meta.stages.reduce((n, x) => n + x.requests, 0);
  const judgments = meta.stages.reduce((n, x) => n + x.judgments, 0);
  const wallMs = meta.stages.reduce((n, x) => n + x.wallMs, 0);
  const errors = meta.stages.reduce((n, x) => n + x.errors, 0);

  return (
    <div className="cards">
      <div className="card">
        <h3>Review progress</h3>
        <div className="big">{stats.decisions.total.toLocaleString()}</div>
        <div className="dim">decisions · {stats.decisions.changed.toLocaleString()} change a translation</div>
        <table style={{ marginTop: 8 }}>
          <tbody>
            {stats.decisions.byVerdict.map(([v, n]) => (
              <tr key={v}>
                <td>{v}</td>
                <td>{n.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Who reviewed</h3>
        {stats.decisions.byWho.length === 0 ? (
          <div className="dim">Nobody yet.</div>
        ) : (
          <table>
            <tbody>
              {stats.decisions.byWho.map(([w, n]) => (
                <tr key={w}>
                  <td>{w}</td>
                  <td>{n.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>Glossary</h3>
        <div className="big">
          {stats.glossary.decided.toLocaleString()}
          <span className="dim" style={{ fontSize: 15 }}>
            {" / "}
            {stats.glossary.total.toLocaleString()}
          </span>
        </div>
        <div className="dim">
          decided · reaches {stats.glossary.keysCovered.toLocaleString()} keys
          {stats.glossary.withGuidance > 0 && ` · ${stats.glossary.withGuidance} carry a written rule`}
        </div>
        <table style={{ marginTop: 8 }}>
          <tbody>
            {stats.glossary.byStatus.map(([st, n]) => (
              <tr key={st}>
                <td>{st}</td>
                <td>{n.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Findings by kind</h3>
        <table>
          <tbody>
            {s.byCategory.map(([c, n]) => (
              <tr key={c} title={CATEGORY_NOTE[c]}>
                <td>
                  <span className={`cat ${c}`}>{c}</span>
                </td>
                <td>{n.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Findings by severity</h3>
        <table>
          <tbody>
            {[3, 2, 1, 0].map((sev) => (
              <tr key={sev}>
                <td>
                  {sev} — {SEVERITY_LABEL[sev]}
                </td>
                <td>{(s.bySeverity[sev] ?? 0).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>By language</h3>
        <table>
          <tbody>
            {s.byLang.map(([l, n]) => (
              <tr key={l}>
                <td className="mono">{l}</td>
                <td>{n.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ gridColumn: "span 2" }}>
        <h3>Why findings were raised</h3>
        <table>
          <tbody>
            {s.byReason.slice(0, 12).map(([r, n]) => (
              <tr key={r}>
                <td>{r}</td>
                <td>{n.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ gridColumn: "span 2" }}>
        <h3>The run these judgments came from</h3>
        <div className="big">{judgments.toLocaleString()}</div>
        <div className="dim">
          judgments · {requests.toLocaleString()} requests · {(wallMs / 1000).toFixed(0)} s · {errors} errors
        </div>
        <div className="dim" style={{ marginTop: 6 }}>
          One LLM call per judgment at 3 s would be {((judgments * 3) / 3600).toFixed(1)} hours.
        </div>
        <table style={{ marginTop: 8 }}>
          <tbody>
            {meta.stages.map((st) => (
              <tr key={st.name}>
                <td>{st.name}</td>
                <td>
                  {st.requests.toLocaleString()} req · {(st.wallMs / 1000).toFixed(1)} s
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>Corpus coverage</h3>
        <div className="big">{pct(s.entriesTouched, s.entriesTotal)}</div>
        <div className="dim">
          {s.entriesTouched.toLocaleString()} of {s.entriesTotal.toLocaleString()} keys have at least one finding
        </div>
      </div>
    </div>
  );
}
