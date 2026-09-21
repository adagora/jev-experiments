import { useCallback, useEffect, useRef, useState } from "react";
import { Meter } from "./Grid.tsx";
import { api } from "../lib/api.ts";
import type { Consistency } from "../lib/wire.ts";

/**
 * Consistency before the fact.
 *
 * Everything else in this app is about drift that already happened: a row exists because an
 * audit flagged it. This panel answers for a string that is being written — including a key
 * nobody has translated yet, which is the moment the drift is cheapest to stop, because it
 * has not happened.
 *
 * Typing costs nothing. Whether a translation uses the rendering the glossary settled on is
 * a fact about the text (L1), so the server establishes it by matching and answers with no
 * API key at all. The semantic half — does this still mean the source, is it good German —
 * is the only part that costs a request, and it is asked for, never assumed.
 */
type Props = { langs: string[]; sourceLang: string; live: boolean; toast: (msg: string, err?: boolean) => void };

export function Check({ langs, sourceLang, live, toast }: Props) {
  const [source, setSource] = useState("");
  const [lang, setLang] = useState(langs[0] ?? "");
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [res, setRes] = useState<Consistency | null>(null);
  const [asking, setAsking] = useState(false);
  const seq = useRef(0);

  // The free half, as you type. No request leaves the machine for this.
  useEffect(() => {
    if (!source.trim()) {
      setRes(null);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      api
        .consistency({ source, lang, text, note, semantic: false })
        .then((r) => {
          if (mine === seq.current) setRes(r);
        })
        .catch((e: Error) => {
          if (mine === seq.current) toast(e.message, true);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [source, lang, text, note, toast]);

  const askMeaning = useCallback(async () => {
    if (!source.trim() || !text.trim()) return;
    const mine = ++seq.current;
    setAsking(true);
    try {
      const r = await api.consistency({ source, lang, text, note, semantic: true });
      if (mine === seq.current) setRes(r);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      if (mine === seq.current) setAsking(false);
    }
  }, [source, lang, text, note, toast]);

  const violations = res?.violations ?? [];
  const rules = res?.glossary ?? [];

  return (
    <div className="editor checkpane">
      <div className="pad">
        <div className="crumb">
          <b>Check a string</b>
          <span>·</span>
          <span>against the glossary as it stands now</span>
          <span className="chip">glossary check is free</span>
          {!live && <span className="chip off">no API key — meaning check off</span>}
        </div>

        <div className="pair">
          <label>Source ({sourceLang})</label>
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            lang={sourceLang}
            placeholder="The English or Polish string you are translating — it need not exist in the corpus"
          />
        </div>

        <div className="pair">
          <label>Language</label>
          <div className="actions">
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              {langs.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="developer note (optional)"
              style={{ flex: 1 }}
            />
          </div>
        </div>

        <div className="pair">
          <label>Your translation</label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck lang={lang} placeholder="Type it here" />
        </div>

        {violations.length > 0 && (
          <div className="pair">
            <label>Glossary</label>
            <div>
              {violations.map((v, i) => (
                <div key={i} className="viol">
                  <div>
                    <b>{v.term}</b> → <b className="ok">{v.canonical}</b>
                    <span className="dim"> · you wrote </span>
                    <span className="bad">{v.used}</span>
                  </div>
                  {v.guidance && <div className="dim">{v.guidance}</div>}
                  <button className="sib" onClick={() => setText(v.suggested)} title="Use this wording">
                    {v.suggested}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {violations.length === 0 && rules.length > 0 && (
          <div className="pair">
            <label>Glossary</label>
            <div>
              <div className="ok">Follows every settled term in this string.</div>
              <div className="sibs" style={{ marginTop: 6 }}>
                {rules.map((g, i) => (
                  <span key={i} className="sib" title={g.guidance ?? ""}>
                    {g.term} → <b>{g.canonical}</b>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {res && rules.length === 0 && (
          <div className="pair">
            <label>Glossary</label>
            <div className="dim">No settled term in this source string, for {lang}.</div>
          </div>
        )}

        <div className="actions">
          <button className="btn" onClick={() => void askMeaning()} disabled={!live || asking || !source.trim() || !text.trim()}>
            {asking ? "asking…" : "Check the meaning"}
            <span className="key-hint">1 request</span>
          </button>
          {res?.judged && (
            <>
              <Meter label="means the same" value={res.judged.meaning} />
              <Meter label={`good ${lang}`} value={res.judged.grammatical} />
              <Meter label="follows glossary" value={res.judged.glossaryOk} />
            </>
          )}
          {res && <span className="chip">{res.ms} ms</span>}
          <span className="grow" />
          <span className="dim">
            {res?.judged ? "one request · the glossary half was free" : "nothing has been spent"}
          </span>
        </div>
      </div>
    </div>
  );
}
