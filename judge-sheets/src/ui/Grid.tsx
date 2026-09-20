import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Store } from "../lib/store.ts";
import { colToName } from "../engine/refs.ts";
import { viewOf } from "./format.ts";

export const ROW_H = 27;
export const HEAD_H = 25;
export const ROWHEAD_W = 48;
export const DEFAULT_COL_W = 120;

/** Something drawn on the canvas just below a cell (intent chip, smart-fill card). */
export type Anchored = { key: string; row: number; col: number; node: React.ReactNode };

export type Selection = { ar: number; ac: number; fr: number; fc: number };
export type Editing = { row: number; col: number; text: string; caretEnd?: boolean } | null;

export const normalize = (s: Selection) => ({
  r1: Math.min(s.ar, s.fr),
  r2: Math.max(s.ar, s.fr),
  c1: Math.min(s.ac, s.fc),
  c2: Math.max(s.ac, s.fc),
});

type Props = {
  store: Store;
  sheet: string;
  sel: Selection;
  setSel: (s: Selection) => void;
  editing: Editing;
  setEditing: (e: Editing) => void;
  commitEdit: (text: string, move: "down" | "right" | "none") => void;
  cancelEdit: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onFill: (toRow: number) => void;
  version: number;
  /** Columns whose predicted values are still a suggestion (drawn as ghosts). */
  ghostCols: Set<number>;
  anchored: Anchored[];
};

export function Grid({
  store,
  sheet,
  sel,
  setSel,
  editing,
  setEditing,
  commitEdit,
  cancelEdit,
  onKeyDown,
  onFill,
  ghostCols,
  anchored,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [fillTo, setFillTo] = useState<number | null>(null);
  const [resizing, setResizing] = useState<{ col: number; startX: number; startW: number } | null>(null);

  const sh = store.wb.getSheet(sheet);
  const widths = useMemo(() => {
    const arr: number[] = [];
    const offs: number[] = [0];
    for (let c = 0; c < sh.cols; c++) {
      const w = sh.colWidths.get(c) ?? DEFAULT_COL_W;
      arr.push(w);
      offs.push(offs[c] + w);
    }
    return { arr, offs, total: offs[sh.cols] };
    // colWidths mutate in place; store.version forces recompute via parent re-render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sh, store.version]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setVp({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const bodyW = vp.w - ROWHEAD_W;
  const bodyH = vp.h - HEAD_H;
  const totalH = sh.rows * ROW_H;

  const r0 = Math.max(0, Math.floor(scroll.top / ROW_H) - 2);
  const r1 = Math.min(sh.rows - 1, Math.ceil((scroll.top + bodyH) / ROW_H) + 2);
  let c0 = 0;
  while (c0 < sh.cols - 1 && widths.offs[c0 + 1] < scroll.left) c0++;
  let c1 = c0;
  while (c1 < sh.cols - 1 && widths.offs[c1] < scroll.left + bodyW) c1++;

  const colAt = useCallback(
    (x: number) => {
      let c = 0;
      while (c < sh.cols - 1 && widths.offs[c + 1] <= x) c++;
      return c;
    },
    [sh.cols, widths],
  );

  // keep the active cell visible
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || bodyW <= 0 || bodyH <= 0) return;
    const top = sel.fr * ROW_H;
    const left = widths.offs[sel.fc];
    const w = widths.arr[sel.fc];
    let { scrollTop, scrollLeft } = el;
    if (top < scrollTop) scrollTop = top;
    else if (top + ROW_H > scrollTop + bodyH) scrollTop = top + ROW_H - bodyH;
    if (left < scrollLeft) scrollLeft = left;
    else if (left + w > scrollLeft + bodyW) scrollLeft = left + w - bodyW;
    if (scrollTop !== el.scrollTop || scrollLeft !== el.scrollLeft) el.scrollTo({ top: scrollTop, left: scrollLeft });
  }, [sel.fr, sel.fc, widths, bodyH, bodyW]);

  useEffect(() => {
    if (editing && inputRef.current) {
      const inp = inputRef.current;
      inp.focus();
      if (editing.caretEnd) inp.setSelectionRange(inp.value.length, inp.value.length);
      else inp.select();
    }
  }, [editing?.row, editing?.col]); // eslint-disable-line react-hooks/exhaustive-deps

  const pointToCell = (e: React.MouseEvent | MouseEvent) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left + el.scrollLeft;
    const y = e.clientY - rect.top + el.scrollTop;
    return { row: Math.max(0, Math.min(sh.rows - 1, Math.floor(y / ROW_H))), col: colAt(Math.max(0, x)) };
  };

  const onBodyMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.dataset.handle === "fill") {
      e.preventDefault();
      const { r2 } = normalize(sel);
      setFillTo(r2);
      const move = (ev: MouseEvent) => setFillTo(Math.max(r2, pointToCell(ev).row));
      const up = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        const to = Math.max(r2, pointToCell(ev).row);
        setFillTo(null);
        if (to > r2) onFill(to);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      return;
    }
    const { row, col } = pointToCell(e);
    if (editing) commitEdit(editing.text, "none");
    if (e.shiftKey) setSel({ ...sel, fr: row, fc: col });
    else setSel({ ar: row, ac: col, fr: row, fc: col });
    const move = (ev: MouseEvent) => {
      const p = pointToCell(ev);
      setSel({ ar: e.shiftKey ? sel.ar : row, ac: e.shiftKey ? sel.ac : col, fr: p.row, fc: p.col });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      wrapRef.current?.focus();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { row, col } = pointToCell(e);
    setEditing({ row, col, text: store.wb.getRaw(sheet, row, col), caretEnd: true });
  };

  const startResize = (col: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { col, startX: e.clientX, startW: widths.arr[col] };
    setResizing(start);
    const move = (ev: MouseEvent) => store.setColWidth(sheet, col, start.startW + ev.clientX - start.startX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setResizing(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const n = normalize(sel);
  const cells: React.ReactNode[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const v = store.wb.getValue(sheet, r, c);
      const view = viewOf(v);
      const inSel = r >= n.r1 && r <= n.r2 && c >= n.c1 && c <= n.c2;
      const inFill = fillTo !== null && r > n.r2 && r <= fillTo && c >= n.c1 && c <= n.c2;
      const raw = store.wb.getRaw(sheet, r, c);
      const isFormula = raw.startsWith("=");
      const ghost = r > 0 && ghostCols.has(c);
      cells.push(
        <div
          key={`${r}:${c}`}
          className={`${view.className}${inSel ? " sel" : ""}${inFill ? " fillpreview" : ""}${isFormula ? " formula" : ""}${r === 0 ? " headrow" : ""}${ghost ? " ghost" : ""}`}
          style={{ ...view.style, top: r * ROW_H, left: widths.offs[c], width: widths.arr[c], height: ROW_H }}
          title={view.title}
        >
          {view.text}
        </div>,
      );
    }
  }

  const colHeads: React.ReactNode[] = [];
  for (let c = c0; c <= c1; c++) {
    colHeads.push(
      <div
        key={c}
        className={`colhead${c >= n.c1 && c <= n.c2 ? " active" : ""}${n.r1 === 0 && n.r2 === sh.rows - 1 && c >= n.c1 && c <= n.c2 ? " full" : ""}`}
        style={{ left: widths.offs[c] - scroll.left, width: widths.arr[c] }}
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).dataset.resize) return;
          setSel({ ar: 0, ac: c, fr: sh.rows - 1, fc: c });
        }}
      >
        {colToName(c)}
        <div
          className={`resize${resizing?.col === c ? " on" : ""}`}
          data-resize="1"
          onMouseDown={(e) => startResize(c, e)}
        />
      </div>,
    );
  }
  const rowHeads: React.ReactNode[] = [];
  for (let r = r0; r <= r1; r++) {
    rowHeads.push(
      <div
        key={r}
        className={`rowhead${r >= n.r1 && r <= n.r2 ? " active" : ""}`}
        style={{ top: r * ROW_H - scroll.top, height: ROW_H }}
        onMouseDown={() => setSel({ ar: r, ac: 0, fr: r, fc: sh.cols - 1 })}
      >
        {r + 1}
      </div>,
    );
  }

  const selStyle = {
    top: n.r1 * ROW_H,
    left: widths.offs[n.c1],
    width: widths.offs[n.c2 + 1] - widths.offs[n.c1],
    height: (n.r2 - n.r1 + 1) * ROW_H,
  };

  return (
    <div className="grid" ref={wrapRef} tabIndex={0} onKeyDown={onKeyDown}>
      <div className="corner" style={{ width: ROWHEAD_W, height: HEAD_H }} />
      <div className="colheads" style={{ left: ROWHEAD_W, height: HEAD_H, width: bodyW }}>
        {colHeads}
      </div>
      <div className="rowheads" style={{ top: HEAD_H, width: ROWHEAD_W, height: bodyH }}>
        {rowHeads}
      </div>
      <div
        className="body"
        ref={scrollRef}
        style={{ top: HEAD_H, left: ROWHEAD_W, width: bodyW, height: bodyH }}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScroll({ top: el.scrollTop, left: el.scrollLeft });
        }}
        onMouseDown={onBodyMouseDown}
        onDoubleClick={onDoubleClick}
      >
        <div className="canvas" style={{ width: widths.total, height: totalH }}>
          {cells}
          <div className="selbox" style={selStyle}>
            <div className="fillhandle" data-handle="fill" />
          </div>
          <div
            className="activebox"
            style={{ top: sel.ar * ROW_H, left: widths.offs[sel.ac], width: widths.arr[sel.ac], height: ROW_H }}
          />
          {editing && (
            <input
              ref={inputRef}
              className="celleditor"
              style={{
                top: editing.row * ROW_H,
                left: widths.offs[editing.col],
                width: Math.max(widths.arr[editing.col], 320),
                height: ROW_H,
              }}
              value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit(editing.text, "down");
                } else if (e.key === "Tab") {
                  e.preventDefault();
                  commitEdit(editing.text, "right");
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
                e.stopPropagation();
              }}
              onBlur={() => {
                if (editing) commitEdit(editing.text, "none");
              }}
              spellCheck={false}
            />
          )}
          {anchored.map((a) => (
            <div
              key={a.key}
              className="anchored"
              style={{ top: (a.row + 1) * ROW_H + 4, left: widths.offs[a.col] }}
              onMouseDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {a.node}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
