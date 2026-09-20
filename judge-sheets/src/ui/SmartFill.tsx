/** Predictive-column UI: the intent chip under a header being typed, the
 *  smart-fill card under a freshly predicted column, and the speed readout. */
import { Icon } from "./icons.tsx";
import { fmtDuration, fmtMs } from "./format.ts";
import { LLM_BASELINE_S_PER_CELL, summarize, type RunStats } from "../lib/jevClient.ts";
import { SCHEMAS, type Intent } from "../lib/predict.ts";
import type { Prediction } from "../lib/store.ts";

export const describeSchema = (s: Prediction["schema"]) =>
  s.kind === "judge" ? "Yes / No" : s.kind === "pick" ? s.options.join(" · ") : `${s.options[0]} → ${s.options[s.options.length - 1]}`;

export function IntentChip({ intent, pending }: { intent: Intent | null; pending: boolean }) {
  return (
    <div className={`intentchip${pending ? " pending" : ""}`}>
      <Icon name="sparkle" size={16} />
      {intent ? (
        <>
          <b>{intent.schema.label}</b>
          <span className="dim">{describeSchema(intent.schema)}</span>
          <span className="dim">· {Math.round(intent.confidence * 100)}% · {fmtMs(intent.ms)}</span>
        </>
      ) : (
        <span className="dim">{pending ? "reading your header…" : "type a header to predict this column"}</span>
      )}
    </div>
  );
}

type CardProps = {
  pred: Prediction;
  run: RunStats;
  now: number;
  onKeep: () => void;
  onUndo: () => void;
  onChange: (schemaId: string) => void;
};

export function SmartFillCard({ pred, run, now, onKeep, onUndo, onChange }: CardProps) {
  const running = pred.elapsedMs === null;
  const elapsed = pred.elapsedMs ?? Math.max(0, now - pred.startedAt);
  const lat = running ? run.latencies : pred.latencies;
  const cells = running ? run.cells : pred.cells;
  const done = running ? run.cellsDone : pred.rows;
  const { p50, p95 } = summarize(lat);
  const rate = elapsed > 0 ? done / (elapsed / 1000) : 0;
  const baseline = pred.rows * LLM_BASELINE_S_PER_CELL;
  const speedup = elapsed > 0 ? (baseline * 1000) / elapsed : 0;
  const pct = cells > 0 ? Math.round((done / cells) * 100) : 0;
  const cached = !running && pred.cells === 0;

  return (
    <div className="smartfill">
      <div className="sfhead">
        <Icon name="sparkle" size={18} className="sfspark" />
        <span className="sftitle">{running ? "Predicting column…" : "Column predicted"}</span>
        <button className="tbtn" title="Undo" onClick={onUndo}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="sfbody">
        <div className="sfrow">
          <span className="sfheader">“{pred.header}”</span>
          <span className="dim">read as</span>
          <select className="sfselect" value={pred.schema.id} onChange={(e) => onChange(e.target.value)} title="Change what this column predicts">
            {SCHEMAS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sfscale dim">{describeSchema(pred.schema)}</div>
        <div className="sfprogress">
          <i style={{ width: `${running ? pct : 100}%` }} />
        </div>
        <div className="sfstats">
          <span className="sfbig">
            {cached ? pred.rows : done}
            <small> rows</small>
          </span>
          <span className="sfbig">
            {cached ? "instant" : fmtMs(elapsed)}
            <small>{cached ? " (cached)" : running ? " so far" : " total"}</small>
          </span>
          {lat.length > 0 && (
            <span className="sfbig">
              {fmtMs(p50)}
              <small> median · p95 {fmtMs(p95)}</small>
            </span>
          )}
          {rate > 0 && (
            <span className="sfbig">
              {rate.toFixed(0)}
              <small> rows / s</small>
            </span>
          )}
        </div>
        <div className="sfbaseline">
          One AI prompt per cell would take <b>{fmtDuration(baseline)}</b>
          {!running && speedup > 1 && <span className="sfspeed">{speedup >= 100 ? speedup.toFixed(0) : speedup.toFixed(1)}× faster</span>}
        </div>
      </div>
      <div className="sfactions">
        <button className="sfbtn primary" onClick={onKeep}>
          <Icon name="check" size={18} /> Keep
        </button>
        <button className="sfbtn" onClick={onUndo}>
          Undo
        </button>
      </div>
    </div>
  );
}

export function SpeedStatus({ run, now, lastError }: { run: RunStats; now: number; lastError: string | null }) {
  if (run.requests === 0) return <span className="dim">Type a column header — the column predicts itself</span>;
  const elapsed = run.active ? now - run.startedAt : run.elapsedMs;
  const { p50 } = summarize(run.latencies);
  const rate = elapsed > 0 ? run.cellsDone / (elapsed / 1000) : 0;
  return (
    <span className="speed">
      <Icon name="bolt" size={16} />
      {run.active ? `Predicting ${run.cellsDone} / ${run.cells}` : `${run.cellsDone} cells`} · {fmtMs(elapsed)} · median {fmtMs(p50)} ·{" "}
      {rate.toFixed(0)} cells/s
      {run.retries > 0 && ` · ${run.retries} retries`}
      {run.errors > 0 && <span className="err"> · {run.errors} errors</span>}
      {lastError && <span className="err"> · {lastError}</span>}
    </span>
  );
}
