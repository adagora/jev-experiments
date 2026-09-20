import type { Corpus, Entry, Lang } from "../types.ts";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Defect = "term-inconsistency" | "placeholder-dropped" | "negation-dropped" | "register-flip" | "case-flip";

export type GroundTruth = { entryId: string; lang: Lang; defect: Defect; canonical: string; injected: string };

const TERMS: { pl: string; tr: Record<Lang, { canonical: string; rival: string }> }[] = [
  { pl: "brama", tr: {
    de: { canonical: "Tor", rival: "Schranke" },
    en: { canonical: "gate", rival: "barrier" },
    uk: { canonical: "ворота", rival: "шлагбаум" },
    fr: { canonical: "portail", rival: "barrière" },
    hu: { canonical: "kapu", rival: "sorompó" } } },
  { pl: "zamówienie", tr: {
    de: { canonical: "Bestellung", rival: "Auftrag" },
    en: { canonical: "order", rival: "request" },
    uk: { canonical: "замовлення", rival: "заявка" },
    fr: { canonical: "commande", rival: "demande" },
    hu: { canonical: "megrendelés", rival: "igénylés" } } },
  { pl: "wycena", tr: {
    de: { canonical: "Angebot", rival: "Bewertung" },
    en: { canonical: "quotation", rival: "valuation" },
    uk: { canonical: "кошторис", rival: "оцінка" },
    fr: { canonical: "devis", rival: "évaluation" },
    hu: { canonical: "árajánlat", rival: "értékelés" } } },
  { pl: "napęd", tr: {
    de: { canonical: "Antrieb", rival: "Motor" },
    en: { canonical: "operator", rival: "motor" },
    uk: { canonical: "привід", rival: "мотор" },
    fr: { canonical: "motorisation", rival: "moteur" },
    hu: { canonical: "hajtás", rival: "motor" } } },
  { pl: "ogrodzenie", tr: {
    de: { canonical: "Zaun", rival: "Umzäunung" },
    en: { canonical: "fence", rival: "fencing" },
    uk: { canonical: "паркан", rival: "огорожа" },
    fr: { canonical: "clôture", rival: "enceinte" },
    hu: { canonical: "kerítés", rival: "körülkerítés" } } },
  { pl: "dostawa", tr: {
    de: { canonical: "Lieferung", rival: "Zustellung" },
    en: { canonical: "delivery", rival: "shipment" },
    uk: { canonical: "доставка", rival: "поставка" },
    fr: { canonical: "livraison", rival: "expédition" },
    hu: { canonical: "szállítás", rival: "kézbesítés" } } },
];

const FRAMES: { pl: string; tr: Record<Lang, string>; hasPlaceholder: boolean; hasNegation: boolean }[] = [
  { pl: "{T}", tr: { de: "{T}", en: "{T}", uk: "{T}", fr: "{T}", hu: "{T}" }, hasPlaceholder: false, hasNegation: false },
  { pl: "Wybierz {T}", tr: { de: "{T} auswählen", en: "Select {T}", uk: "Виберіть {T}", fr: "Sélectionnez {T}", hu: "Válasszon {T}" }, hasPlaceholder: false, hasNegation: false },
  { pl: "{T} nr {0} została zapisana", tr: { de: "{T} Nr. {0} wurde gespeichert", en: "{T} no. {0} has been saved", uk: "{T} № {0} збережено", fr: "{T} n° {0} a été enregistré", hu: "{T} sz. {0} mentve" }, hasPlaceholder: true, hasNegation: false },
  { pl: "{T} nr {0} nie została zapisana", tr: { de: "{T} Nr. {0} wurde nicht gespeichert", en: "{T} no. {0} has not been saved", uk: "{T} № {0} не збережено", fr: "{T} n° {0} n'a pas été enregistré", hu: "{T} sz. {0} nem lett mentve" }, hasPlaceholder: true, hasNegation: true },
  { pl: "Nie można usunąć {T}, ponieważ jest w użyciu", tr: { de: "{T} kann nicht gelöscht werden, da es in Verwendung ist", en: "Cannot delete {T} because it is in use", uk: "Неможливо видалити {T}, оскільки він використовується", fr: "Impossible de supprimer {T} car il est en cours d'utilisation", hu: "A {T} nem törölhető, mert használatban van" }, hasPlaceholder: false, hasNegation: true },
  { pl: "Czy na pewno chcesz usunąć {T}?", tr: { de: "Möchten Sie {T} wirklich löschen?", en: "Do you really want to delete {T}?", uk: "Ви дійсно хочете видалити {T}?", fr: "Voulez-vous vraiment supprimer {T} ?", hu: "Biztosan törli a következőt: {T}?" }, hasPlaceholder: false, hasNegation: false },
  { pl: "Podaj {T} aby kontynuować", tr: { de: "Geben Sie {T} ein, um fortzufahren", en: "Enter {T} to continue", uk: "Введіть {T}, щоб продовжити", fr: "Saisissez {T} pour continuer", hu: "Adja meg: {T} a folytatáshoz" }, hasPlaceholder: false, hasNegation: false },
  { pl: "Liczba pozycji: {0}", tr: { de: "Anzahl der Positionen: {0}", en: "Number of items: {0}", uk: "Кількість позицій: {0}", fr: "Nombre d'articles : {0}", hu: "Tételek száma: {0}" }, hasPlaceholder: true, hasNegation: false },
];

const INFORMAL: Record<Lang, [RegExp, string][]> = {
  de: [[/\bSie\b/g, "du"], [/\bIhnen\b/g, "dir"], [/Möchten du/g, "Möchtest du"], [/Geben du ein/g, "Gib ein"]],
  en: [],
  uk: [[/\bВи\b/g, "ти"], [/Виберіть/g, "вибери"], [/Введіть/g, "введи"]],
  fr: [[/\bvous\b/g, "tu"], [/Sélectionnez/g, "Sélectionne"], [/Saisissez/g, "Saisis"], [/Voulez-vous/g, "Veux-tu"]],
  hu: [[/Válasszon/g, "Válassz"], [/Adja meg/g, "Add meg"], [/Biztosan törli/g, "Biztosan törlöd"]],
};

export type SyntheticOptions = {
  keys: number;
  langs: Lang[];
  seed?: number;
  defectRate?: number;
};

export function generateSynthetic(opts: SyntheticOptions): { corpus: Corpus; truth: GroundTruth[] } {
  const rnd = mulberry32(opts.seed ?? 20250920);
  const langs = opts.langs.filter((l) => l !== "pl");
  const defectRate = opts.defectRate ?? 0.08;
  const entries: Entry[] = [];
  const truth: GroundTruth[] = [];

  for (let i = 0; i < opts.keys; i++) {
    const term = TERMS[Math.floor(rnd() * TERMS.length)];
    const frame = FRAMES[Math.floor(rnd() * FRAMES.length)];
    const id = `syn-${String(i + 1).padStart(5, "0")}`;
    const source = frame.pl.replace("{T}", term.pl);
    const tr: Record<Lang, string> = { pl: source };

    for (const lang of langs) {
      const canonical = term.tr[lang]?.canonical;
      const rival = term.tr[lang]?.rival;
      const frameTr = frame.tr[lang];
      if (!canonical || !frameTr) continue;
      let value = frameTr.replace("{T}", canonical);

      if (rnd() < defectRate) {
        const options: Defect[] = ["term-inconsistency", "register-flip", "case-flip"];
        if (frame.hasPlaceholder) options.push("placeholder-dropped");
        if (frame.hasNegation) options.push("negation-dropped");
        const defect = options[Math.floor(rnd() * options.length)];
        const before = value;

        switch (defect) {
          case "term-inconsistency":
            value = frameTr.replace("{T}", rival);
            break;
          case "placeholder-dropped":
            value = value.replace(/\s*\{0\}/, "");
            break;
          case "negation-dropped":
            value = value
              .replace(/\bnicht\s*/g, "").replace(/\bnot\s*/g, "").replace(/\bне\s*/g, "")
              .replace(/n'a pas\s*/g, "a ").replace(/\bnem\s*/g, "")
              .replace(/kann nicht/g, "kann").replace(/Cannot/g, "Can").replace(/Неможливо/g, "Можливо")
              .replace(/Impossible de/g, "Possible de").replace(/nem törölhető/g, "törölhető");
            break;
          case "register-flip":
            for (const [re, to] of INFORMAL[lang] ?? []) value = value.replace(re, to);
            break;
          case "case-flip":
            value = value.toUpperCase();
            break;
        }
        if (value !== before) truth.push({ entryId: id, lang, defect, canonical: before, injected: value });
      }
      tr[lang] = value;
    }

    entries.push({
      id,
      project: "synthetic",
      keyName: `syn.${term.pl}.${i + 1}`,
      source,
      description: "",
      context: "",
      tags: [],
      tr,
      status: {},
    });
  }

  return {
    corpus: {
      sourceLang: "pl",
      langs: ["pl", ...langs],
      entries,
      origin: `synthetic (${opts.keys} keys, seed ${opts.seed ?? 20250920}, ${truth.length} injected defects)`,
    },
    truth,
  };
}
