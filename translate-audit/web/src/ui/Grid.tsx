import { useEffect, useLayoutEffect, useRef, useState } from "react";

export const ROW_H = 30;

export type Column = { key: string; label: string; width: string };

type Props<T> = {
  columns: Column[];
  rows: T[];
  total: number;
  rowKey: (row: T, index: number) => string;
  renderRow: (row: T, index: number) => React.ReactNode;
  selected: number;
  onSelect: (index: number) => void;
  rowClass?: (row: T, index: number) => string;
  onNeedMore?: () => void;
  empty?: React.ReactNode;
};

export function Grid<T>({
  columns,
  rows,
  total,
  rowKey,
  renderRow,
  selected,
  onSelect,
  rowClass,
  onNeedMore,
  empty,
}: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const template = columns.map((c) => c.width).join(" ");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || selected < 0) return;
    const top = selected * ROW_H;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight - ROW_H * 2;
    if (top < viewTop) el.scrollTop = top - ROW_H;
    else if (top > viewBottom) el.scrollTop = top - el.clientHeight + ROW_H * 3;
  }, [selected]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 6);

  const requestedAt = useRef(-1);
  useEffect(() => {
    if (!onNeedMore) return;
    if (rows.length >= total) return;
    if (last < rows.length - 20) return;
    if (requestedAt.current === rows.length) return;
    requestedAt.current = rows.length;
    onNeedMore();
  }, [last, rows.length, total, onNeedMore]);

  return (
    <div
      className="grid"
      ref={ref}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
    >
      <div className="gridhead" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => (
          <div key={c.key}>{c.label}</div>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="empty">{empty ?? "Nothing here."}</div>
      ) : (
        <div className="rows" style={{ height: rows.length * ROW_H }}>
          {rows.slice(first, last).map((row, i) => {
            const index = first + i;
            return (
              <div
                key={rowKey(row, index)}
                className={`row ${index === selected ? "on" : ""} ${rowClass?.(row, index) ?? ""}`}
                style={{ top: index * ROW_H, height: ROW_H, gridTemplateColumns: template }}
                onMouseDown={() => onSelect(index)}
              >
                {renderRow(row, index)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Meter({ label, value, invert }: { label: string; value: number | null | undefined; invert?: boolean }) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const good = invert ? 1 - value : value;
  const hue = Math.round(good * 120);
  return (
    <span className="meter" title={`${label} ${value.toFixed(3)}`}>
      <span className="dim">{label}</span>
      <span className="bar">
        <i style={{ width: `${Math.round(value * 100)}%`, background: `hsl(${hue} 62% 45%)` }} />
      </span>
      <b>{value.toFixed(2)}</b>
    </span>
  );
}

export const SEV_FILL = ["var(--sev0)", "var(--sev1)", "var(--sev2)", "var(--sev3)"];
export const SEV_DOT = ["#c7c7c7", "#f0b429", "#e8710a", "#d93025"];
