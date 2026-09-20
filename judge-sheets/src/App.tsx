import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Store } from "./lib/store.ts";
import { classifyIntent, schemaById, type Intent } from "./lib/predict.ts";
import { Grid, normalize, type Anchored, type Editing, type Selection } from "./ui/Grid.tsx";
import { SheetTabs, TitleBar, Toolbar } from "./ui/Chrome.tsx";
import { IntentChip, SmartFillCard, SpeedStatus } from "./ui/SmartFill.tsx";
import { colToName } from "./engine/refs.ts";

const store = new Store();
store.fetchHealth();
store.tick();
Object.assign(window, { judgeSheets: store });

const INTENT_DEBOUNCE_MS = 120;

export default function App() {
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  const [sheet, setSheet] = useState("Reviews");
  const [sel, setSel] = useState<Selection>({ ar: 0, ac: 4, fr: 0, fc: 4 });
  const [editing, setEditing] = useState<Editing>(null);
  const [bar, setBar] = useState<{ sheet: string; row: number; col: number; text: string } | null>(null);
  const [now, setNow] = useState(performance.now());
  const [intent, setIntent] = useState<Intent | null>(null);
  const [intentPending, setIntentPending] = useState(false);
  const intentSeq = useRef(0);
  const lastIntent = useRef<Intent | null>(null);

  const sheets = [...store.wb.sheets.keys()];
  const sh = store.wb.getSheet(sheet);
  const raw = store.wb.getRaw(sheet, sel.ar, sel.ac);

  // live clock while a run is active
  const active = store.runner.run.active;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, [active]);
  useEffect(() => setNow(performance.now()), [version]);

  // ------------------------------------------------------- keystroke intent
  const headerEdit = editing && editing.row === 0 && store.isPredictable(sheet, editing.col) ? editing : null;
  const headerText = headerEdit?.text.trim() ?? "";
  const headerCol = headerEdit?.col ?? -1;
  useEffect(() => {
    if (headerCol < 0) {
      setIntent(null);
      setIntentPending(false);
      return;
    }
    if (headerText.length < 2) {
      setIntent(null);
      return;
    }
    const seq = ++intentSeq.current;
    const ctrl = new AbortController();
    setIntentPending(true);
    const id = setTimeout(() => {
      const textCol = store.prediction(sheet, headerCol)?.textCol ?? store.findTextColumn(sheet, headerCol);
      classifyIntent(headerText, store.sampleTexts(sheet, textCol), ctrl.signal)
        .then((it) => {
          if (seq !== intentSeq.current) return;
          lastIntent.current = it;
          setIntent(it);
          setIntentPending(false);
        })
        .catch(() => {
          if (seq === intentSeq.current) setIntentPending(false);
        });
    }, INTENT_DEBOUNCE_MS);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [headerText, headerCol, sheet]);

  const predict = useCallback(
    async (col: number, header: string, schemaId?: string) => {
      let schema = schemaId ? schemaById(schemaId) : undefined;
      if (!schema) {
        const cached = lastIntent.current;
        if (cached && cached.header === header) schema = cached.schema;
        else {
          const textCol = store.prediction(sheet, col)?.textCol ?? store.findTextColumn(sheet, col);
          try {
            schema = (await classifyIntent(header, store.sampleTexts(sheet, textCol))).schema;
          } catch {
            return;
          }
        }
      }
      store.predictColumn(sheet, col, header, schema);
    },
    [sheet],
  );

  const move = useCallback(
    (dr: number, dc: number, extend = false) => {
      const r = Math.max(0, Math.min(sh.rows - 1, (extend ? sel.fr : sel.ar) + dr));
      const c = Math.max(0, Math.min(sh.cols - 1, (extend ? sel.fc : sel.ac) + dc));
      setSel(extend ? { ...sel, fr: r, fc: c } : { ar: r, ac: c, fr: r, fc: c });
    },
    [sel, sh.rows, sh.cols],
  );

  const commitEdit = useCallback(
    (text: string, dir: "down" | "right" | "none") => {
      if (!editing) return;
      const { row, col } = editing;
      const predictable = row === 0 && store.isPredictable(sheet, col);
      const changed = text !== store.wb.getRaw(sheet, row, col);
      store.setCell(sheet, row, col, text);
      setEditing(null);
      setBar(null);
      if (predictable && changed) {
        if (text.trim() === "") store.dismissPrediction(sheet, col);
        else void predict(col, text.trim());
      }
      if (dir === "down") move(1, 0);
      else if (dir === "right") move(0, 1);
    },
    [editing, sheet, move, predict],
  );
  const cancelEdit = useCallback(() => {
    setEditing(null);
    setBar(null);
  }, []);

  const fillSelection = useCallback(() => {
    const n = normalize(sel);
    if (n.r2 === n.r1) return;
    for (let c = n.c1; c <= n.c2; c++) store.fillDown(sheet, n.r1, c, n.r2);
  }, [sel, sheet]);

  const onFill = useCallback(
    (toRow: number) => {
      const n = normalize(sel);
      for (let c = n.c1; c <= n.c2; c++) store.fillDown(sheet, n.r1, c, toRow);
      setSel({ ar: n.r1, ac: n.c1, fr: toRow, fc: n.c2 });
    },
    [sel, sheet],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        fillSelection();
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        void navigator.clipboard?.writeText(store.wb.getRaw(sheet, sel.ar, sel.ac));
        return;
      }
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(mod ? sh.rows : 1, 0, e.shiftKey);
          return;
        case "ArrowUp":
          e.preventDefault();
          move(mod ? -sh.rows : -1, 0, e.shiftKey);
          return;
        case "ArrowLeft":
          e.preventDefault();
          move(0, -1, e.shiftKey);
          return;
        case "ArrowRight":
        case "Tab":
          e.preventDefault();
          move(0, e.shiftKey && e.key === "Tab" ? -1 : 1, e.shiftKey && e.key !== "Tab");
          return;
        case "PageDown":
          e.preventDefault();
          move(20, 0, e.shiftKey);
          return;
        case "PageUp":
          e.preventDefault();
          move(-20, 0, e.shiftKey);
          return;
        case "Enter":
        case "F2":
          e.preventDefault();
          setEditing({ row: sel.ar, col: sel.ac, text: store.wb.getRaw(sheet, sel.ar, sel.ac), caretEnd: true });
          return;
        case "Delete":
        case "Backspace": {
          e.preventDefault();
          const n = normalize(sel);
          for (let r = n.r1; r <= n.r2; r++)
            for (let c = n.c1; c <= n.c2; c++) if (store.wb.getRaw(sheet, r, c)) store.setCell(sheet, r, c, "");
          for (let c = n.c1; c <= n.c2; c++) if (n.r1 === 0 && store.prediction(sheet, c)) store.dismissPrediction(sheet, c);
          return;
        }
        case "Escape":
          setSel({ ar: sel.ar, ac: sel.ac, fr: sel.ar, fc: sel.ac });
          return;
        default:
          if (e.key.length === 1 && !mod && !e.altKey) {
            e.preventDefault();
            setEditing({ row: sel.ar, col: sel.ac, text: e.key, caretEnd: true });
          }
      }
    },
    [editing, sel, sheet, sh.rows, move, fillSelection],
  );

  const barOwnsSel = bar !== null && bar.sheet === sheet && bar.row === sel.ar && bar.col === sel.ac;
  const barValue = editing ? editing.text : barOwnsSel ? bar.text : raw;
  const commitBar = useCallback(() => {
    if (!bar) return;
    if (bar.text !== store.wb.getRaw(bar.sheet, bar.row, bar.col)) {
      store.setCell(bar.sheet, bar.row, bar.col, bar.text);
      if (bar.row === 0 && store.isPredictable(bar.sheet, bar.col) && bar.text.trim()) void predict(bar.col, bar.text.trim());
    }
    setBar(null);
  }, [bar, predict]);
  const n = normalize(sel);
  const cellName = `${colToName(sel.ac)}${sel.ar + 1}`;
  const rangeName = n.r1 === n.r2 && n.c1 === n.c2 ? cellName : `${colToName(n.c1)}${n.r1 + 1}:${colToName(n.c2)}${n.r2 + 1}`;

  // ------------------------------------------------------------- overlays
  const open = store.openPrediction(sheet);
  const ghostCols = new Set<number>();
  for (const p of store.predictions.values()) if (p.sheet === sheet && !p.accepted) ghostCols.add(p.col);
  const anchored: Anchored[] = [];
  if (headerEdit) {
    anchored.push({ key: "intent", row: 0, col: headerEdit.col, node: <IntentChip intent={intent} pending={intentPending} /> });
  }
  if (open && !(headerEdit && headerEdit.col === open.col)) {
    anchored.push({
      key: `card:${open.col}`,
      row: 0,
      col: open.col + 1,
      node: (
        <SmartFillCard
          pred={open}
          run={store.runner.run}
          now={now}
          onKeep={() => store.acceptPrediction(sheet, open.col)}
          onUndo={() => {
            store.dismissPrediction(sheet, open.col);
            store.setCell(sheet, 0, open.col, "");
          }}
          onChange={(id) => void predict(open.col, open.header, id)}
        />
      ),
    });
  }

  return (
    <div className="app">
      <TitleBar title={sheet === "Leads" ? "Inbound leads" : "Customer reviews"} health={store.health} />
      <Toolbar bold={sel.ar === 0} />

      <div className="formulabar">
        <div className="namebox">
          {rangeName}
          <span className="nbdd">▾</span>
        </div>
        <span className="fx">fx</span>
        <input
          className="formulainput"
          value={barValue}
          spellCheck={false}
          onFocus={() => setBar({ sheet, row: sel.ar, col: sel.ac, text: raw })}
          onChange={(e) => {
            if (editing) setEditing({ ...editing, text: e.target.value });
            else setBar({ sheet, row: sel.ar, col: sel.ac, text: e.target.value });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (editing) commitEdit(editing.text, "down");
              else commitBar();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              cancelEdit();
              (e.target as HTMLInputElement).blur();
            }
          }}
          onBlur={() => {
            if (editing) return;
            commitBar();
          }}
        />
      </div>

      <Grid
        store={store}
        sheet={sheet}
        sel={sel}
        setSel={setSel}
        editing={editing}
        setEditing={setEditing}
        commitEdit={commitEdit}
        cancelEdit={cancelEdit}
        onKeyDown={onKeyDown}
        onFill={onFill}
        version={version}
        ghostCols={ghostCols}
        anchored={anchored}
      />

      <SheetTabs
        sheets={sheets}
        current={sheet}
        onSelect={(s) => {
          setSheet(s);
          setSel({ ar: 0, ac: s === "Leads" ? 5 : 4, fr: 0, fc: s === "Leads" ? 5 : 4 });
          setEditing(null);
        }}
        status={<SpeedStatus run={store.runner.run} now={now} lastError={store.runner.lastError} />}
      />
    </div>
  );
}
