/** Google Sheets chrome: title bar, menus, toolbar, formula bar and sheet tabs. */
import { Icon, SheetsLogo, type IconName } from "./icons.tsx";
import type { Health } from "../lib/store.ts";

const MENUS = ["File", "Edit", "View", "Insert", "Format", "Data", "Tools", "Extensions", "Help"];

export function TitleBar({ title, health }: { title: string; health: Health }) {
  const status =
    health.mode === "live"
      ? { cls: "live", text: `Predictions live · ${health.model}` }
      : health.mode === "mock"
        ? { cls: "warn", text: "Mock mode — replayed answers" }
        : health.mode === "nokey"
          ? { cls: "bad", text: "No API key — set TYPESAFE_API_KEY" }
          : { cls: "bad", text: "Prediction server offline" };
  return (
    <header className="titlebar">
      <div className="logo">
        <SheetsLogo />
      </div>
      <div className="titleblock">
        <div className="titlerow">
          <span className="doctitle">{title}</span>
          <Icon name="star" size={18} className="ticon" />
          <Icon name="folder" size={18} className="ticon" />
          <Icon name="cloud" size={18} className="ticon" />
          <span className={`livechip ${status.cls}`}>
            <Icon name="bolt" size={14} />
            {status.text}
          </span>
        </div>
        <nav className="menus">
          {MENUS.map((m) => (
            <span key={m} className="menu">
              {m}
            </span>
          ))}
        </nav>
      </div>
      <div className="titleactions">
        <Icon name="history" size={22} className="ticon big" />
        <Icon name="comment" size={22} className="ticon big" />
        <span className="meet">
          <Icon name="videocam" size={20} />
          <Icon name="dropdown" size={18} />
        </span>
        <button className="share">
          <Icon name="lock" size={18} />
          Share
          <Icon name="dropdown" size={18} />
        </button>
        <span className="avatar">N</span>
      </div>
    </header>
  );
}

const TB = (name: IconName, title: string) => ({ name, title });
const TOOLS_A = [TB("undo", "Undo"), TB("redo", "Redo"), TB("print", "Print"), TB("paint", "Paint format")];
const TOOLS_B = [TB("bold", "Bold"), TB("italic", "Italic"), TB("strike", "Strikethrough"), TB("textcolor", "Text color")];
const TOOLS_C = [TB("fill", "Fill color"), TB("borders", "Borders"), TB("merge", "Merge cells")];
const TOOLS_D = [TB("alignleft", "Horizontal align"), TB("valign", "Vertical align"), TB("wrap", "Text wrapping"), TB("rotate", "Text rotation")];
const TOOLS_E = [TB("link", "Insert link"), TB("addcomment", "Insert comment"), TB("chart", "Insert chart"), TB("filter", "Create a filter"), TB("functions", "Functions")];

function Tools({ items }: { items: { name: IconName; title: string }[] }) {
  return (
    <>
      {items.map((t) => (
        <button key={t.name} className="tbtn" title={t.title}>
          <Icon name={t.name} size={18} />
        </button>
      ))}
    </>
  );
}
const Sep = () => <span className="tsep" />;

export function Toolbar({ bold }: { bold: boolean }) {
  return (
    <div className="toolbar">
      <div className="toolpill">
        <button className="tbtn" title="Search the menus (Alt+/)">
          <Icon name="search" size={18} />
        </button>
        <Tools items={TOOLS_A} />
        <span className="tdd zoom">
          125% <Icon name="dropdown" size={16} />
        </span>
        <Sep />
        <span className="ttext">$</span>
        <span className="ttext">%</span>
        <span className="ttext small">.0</span>
        <span className="ttext small">.00</span>
        <span className="tdd">
          123 <Icon name="dropdown" size={16} />
        </span>
        <Sep />
        <span className="tdd font">
          Default (Ari... <Icon name="dropdown" size={16} />
        </span>
        <Sep />
        <span className="tsize">
          <span className="ttext">−</span>
          <span className="tnum">10</span>
          <span className="ttext">+</span>
        </span>
        <Sep />
        <button className={`tbtn${bold ? " on" : ""}`} title="Bold">
          <Icon name="bold" size={18} />
        </button>
        <Tools items={TOOLS_B.slice(1)} />
        <Sep />
        <Tools items={TOOLS_C} />
        <Sep />
        <Tools items={TOOLS_D} />
        <Sep />
        <Tools items={TOOLS_E} />
        <span className="tspacer" />
        <button className="tbtn" title="Hide the menus">
          <Icon name="up" size={18} />
        </button>
      </div>
    </div>
  );
}

export function SheetTabs({
  sheets,
  current,
  onSelect,
  status,
}: {
  sheets: string[];
  current: string;
  onSelect: (s: string) => void;
  status: React.ReactNode;
}) {
  return (
    <footer className="sheettabs">
      <button className="tbtn" title="Add sheet">
        <Icon name="add" size={20} />
      </button>
      <button className="tbtn" title="All sheets">
        <Icon name="menu" size={20} />
      </button>
      {sheets.map((s) => (
        <button key={s} className={`stab${s === current ? " on" : ""}`} onClick={() => onSelect(s)}>
          {s}
          <Icon name="dropdown" size={16} className="stabdd" />
        </button>
      ))}
      <div className="tabstatus">{status}</div>
    </footer>
  );
}
