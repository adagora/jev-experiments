import type { Entry, GlossaryEntry, Lang, TermConflict } from "../types.ts";
import { choice, noul, score, type Question } from "./client.ts";
import { norm } from "../util/text.ts";

export const LANG_NAMES: Record<string, string> = {
  pl: "Polish",
  en: "English",
  de: "German",
  fr: "French",
  cs: "Czech",
  it: "Italian",
  ru: "Russian",
  uk: "Ukrainian",
  hu: "Hungarian",
  es: "Spanish",
  sk: "Slovak",
  ro: "Romanian",
  nl: "Dutch",
  lt: "Lithuanian",
  lv: "Latvian",
  et: "Estonian",
};

export const langName = (iso: Lang): string => LANG_NAMES[iso] ?? iso;

export const CONTEXT_DEPENDENT = "no single rendering fits — the right wording depends on where the term appears";

export const REGISTER_FORMAL = "formal — the polite form of address";
export const REGISTER_INFORMAL = "informal — the familiar form of address";
export const REGISTER_NONE = "neither — the text does not address a reader";

export type ArbitrationState = {
  domain: string;
  source_language: string;
  target_language: string;
  source_term: string;
  observed_renderings: { rendering: string; used_in_keys: number }[];
  usage_examples: { source: string; translation: string }[];
  projects: string[];
};

export function arbitrationState(
  conflict: TermConflict,
  entries: Map<string, Entry>,
  sourceLang: Lang,
  domain: string,
): ArbitrationState {
  const examples: ArbitrationState["usage_examples"] = [];
  for (const v of conflict.variants) {
    for (const id of v.examples.slice(0, 2)) {
      const e = entries.get(id);
      if (!e) continue;
      examples.push({ source: norm(e.source), translation: v.text });
      if (examples.length >= 6) break;
    }
    if (examples.length >= 6) break;
  }
  const projects = [...new Set(conflict.entryIds.map((id) => entries.get(id)?.project).filter(Boolean) as string[])];
  return {
    domain,
    source_language: langName(sourceLang),
    target_language: langName(conflict.lang),
    source_term: conflict.term,
    observed_renderings: conflict.variants.map((v) => ({ rendering: v.text, used_in_keys: v.count })),
    usage_examples: examples,
    projects,
  };
}

export function arbitrationQuestions(conflict: TermConflict): Record<string, Question> {
  const target = langName(conflict.lang);
  const options: Record<string, string | null> = {};
  for (const v of conflict.variants) {
    options[v.text] = `Used in ${v.count} key${v.count === 1 ? "" : "s"} of the product.`;
  }
  options[CONTEXT_DEPENDENT] =
    "The observed renderings are not interchangeable: each is correct in some places and wrong in others, so a single glossary entry would cause bad translations.";

  return {
    canonical: choice(
      `The product's ${target} translations render the same source term \`source_term\` in more than one way. ` +
        `Which rendering should become the single canonical ${target} term used everywhere in this product?`,
      options,
    ),
    interchangeable: noul(
      `Could every rendering in \`observed_renderings\` be swapped for any other, in every place the term appears, ` +
        `without changing what a ${target} reader understands?`,
      {
        true: "The renderings are synonyms in this domain; the variation is stylistic only.",
        false: "At least one rendering means something different, or is wrong in at least one of the places it is used.",
      },
    ),
    doNotTranslate: noul(
      `Is \`source_term\` a brand, product-family or model name that should keep its original form in ${target} rather than being translated?`,
    ),
    severity: score(
      `A reader of the product in ${target} encounters this term rendered inconsistently across screens. How much damage does that do?`,
      [
        "none — a reader would not notice, or the variation is purely stylistic",
        "cosmetic — noticeable unevenness, but meaning is never in doubt",
        "confusing — a reader could believe two different things are being referred to",
        "wrong — at least one rendering names the wrong thing and will mislead or cause a mistake",
      ],
    ),
    covered: noul(
      `Is the correct ${target} translation of \`source_term\` present among \`observed_renderings\`, ` +
        `or is every rendering translators have used so far wrong?`,
      {
        true: "At least one of the observed renderings is the right term.",
        false: "None of them is right; the correct term does not appear in the corpus yet.",
      },
    ),
    sourceAmbiguous: noul(
      `Is the inconsistency caused by \`source_term\` itself being ambiguous in ${langName("pl")}, so that the source string ` +
        `should be clarified rather than the translations aligned?`,
    ),
  };
}

export type AuditState = {
  project: string;
  key_name: string;
  source_language: string;
  source: string;
  developer_note: string;
  translations: Record<string, string>;
  automated_checks: Record<string, string[]>;
  glossary: { term: string; canonical: Record<string, string>; rule?: Record<string, string> }[];
};

export function auditState(
  entry: Entry,
  langs: Lang[],
  sourceLang: Lang,
  lintByLang: Map<Lang, string[]>,
  glossary: GlossaryEntry[],
  guidance?: Map<string, { lang: Lang; guidance: string }[]>,
): AuditState {
  const translations: Record<string, string> = {};
  for (const l of langs) {
    const v = norm(entry.tr[l] ?? "");
    if (v) translations[langName(l)] = v;
  }
  const automated_checks: Record<string, string[]> = {};
  for (const [l, msgs] of lintByLang) if (msgs.length) automated_checks[langName(l)] = msgs;

  const byTerm = new Map<string, Record<string, string>>();
  for (const g of glossary) {
    if (!g.canonical) continue;
    let rec = byTerm.get(g.term);
    if (!rec) byTerm.set(g.term, (rec = {}));
    rec[langName(g.lang)] = g.canonical;
  }

  const rules = new Map<string, Record<string, string>>();
  for (const [term, entries] of guidance ?? []) {
    if (!byTerm.has(term)) continue;
    const rec: Record<string, string> = {};
    for (const e of entries) rec[langName(e.lang)] = e.guidance;
    rules.set(term, rec);
  }

  return {
    project: entry.project,
    key_name: entry.keyName,
    source_language: langName(sourceLang),
    source: norm(entry.source),
    developer_note: norm(entry.description || entry.context),
    translations,
    automated_checks,
    glossary: [...byTerm.entries()].map(([term, canonical]) => {
      const rule = rules.get(term);
      return rule ? { term, canonical, rule } : { term, canonical };
    }),
  };
}

export type AuditPlan = {
  meaning: Lang[];
  adherence: Lang[];
  register: Lang[];
};

export function auditQuestions(plan: AuditPlan, sourceLang: Lang): Record<string, Question> {
  const q: Record<string, Question> = {
    uiString: noul(
      "Is `source` a piece of text that a person using the product will read on screen, " +
        "rather than an internal identifier, symbol name, code constant or configuration value?",
      {
        true: "A label, message, button, heading, sentence or other human-facing wording.",
        false: "A technical key such as `WidthX`, `ktm_b2100` or `Type.symbol~DZ~name`, meaningful only to developers.",
      },
    ),
  };

  for (const lang of plan.meaning) {
    const name = langName(lang);
    q[`meaning:${lang}`] = noul(
      `Does \`translations.${name}\` state the same thing as \`source\`, including every negation, number, quantity, ` +
        `condition and obligation it contains?`,
      {
        true: `A ${name} reader would act on \`translations.${name}\` exactly as a ${langName(sourceLang)} reader acts on \`source\`.`,
        false:
          "A negation, number, condition or obligation was added, dropped or reversed, or the translation refers to a different thing than the source does.",
      },
    );
  }

  for (const lang of plan.adherence) {
    const name = langName(lang);
    q[`adheres:${lang}`] = noul(
      `For every term listed in \`glossary\`, does \`translations.${name}\` use that term's canonical \`${name}\` rendering ` +
        `(allowing for normal grammatical inflection) rather than a different wording for the same thing? ` +
        `Where a term carries a \`rule\`, that rule decides which rendering is correct here.`,
    );
  }

  for (const lang of plan.register) {
    const name = langName(lang);
    q[`register:${lang}`] = choice(
      `How does \`translations.${name}\` address the person reading it?`,
      {
        [REGISTER_FORMAL]:
          "With the polite form — Sie/Ihnen, Pan/Pani, vous, Ön, Вы, Ви — or a verb form that only the polite register uses.",
        [REGISTER_INFORMAL]:
          "With the familiar form — du/dir, ty, tu/te, ты, ти — or a verb form that only the familiar register uses.",
        [REGISTER_NONE]:
          "It does not address anyone: a label, a heading, a noun phrase, or an instruction in the infinitive or imperative-impersonal form.",
      },
    );
  }

  return q;
}

export type SubstitutionState = {
  target_language: string;
  source: string;
  before: string;
  after: string;
  replaced_term: string;
  canonical_term: string;
};

export function substitutionQuestions(lang: Lang): Record<string, Question> {
  const name = langName(lang);
  return {
    grammatical: noul(
      `\`after\` was produced by mechanically replacing \`replaced_term\` with \`canonical_term\` inside \`before\`. ` +
        `Is \`after\` well-formed, natural ${name}, with correct inflection and agreement around the replaced term?`,
      {
        true: `A ${name} speaker would write it that way.`,
        false: "The replacement left a grammatical error — wrong case, gender, number or word order.",
      },
    ),
    preserved: noul(`Does \`after\` still state the same thing as \`source\`?`),
    improved: noul(
      `Is \`after\` a better translation of \`source\` than \`before\` is, for a product that uses \`canonical_term\` as its standard term?`,
    ),
  };
}
