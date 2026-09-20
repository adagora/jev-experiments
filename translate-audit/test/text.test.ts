import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_RE,
  caseShape,
  containsTerm,
  fold,
  foldHard,
  matchCase,
  multiset,
  multisetDiff,
  looksLikeIdentifier,
  replaceTerm,
  tagNames,
  terminalPunct,
  triviallyEquivalent,
  wordCount,
} from "../src/util/text.ts";

describe("placeholders", () => {
  it("recognises the dialects that appear in the corpus", () => {
    const found = [...("{0} {crlf} _MAX_ %s %1$s ${x} {{name}} [[a]]".matchAll(PLACEHOLDER_RE))].map((m) => m[0]);
    expect(found).toEqual(["{0}", "{crlf}", "_MAX_", "%s", "%1$s", "${x}", "{{name}}", "[[a]]"]);
  });

  it("reports a dropped placeholder as a count difference", () => {
    const src = multiset("Cena {0} nie {1} {3}", PLACEHOLDER_RE);
    const tgt = multiset("Der Preis {0} ( {1} )", PLACEHOLDER_RE);
    expect(multisetDiff(src, tgt)).toEqual(["{3}: 1→0"]);
  });

  it("is silent when the placeholders match", () => {
    expect(multisetDiff(multiset("a {0} b", PLACEHOLDER_RE), multiset("{0} x", PLACEHOLDER_RE))).toEqual([]);
  });

  it("counts repeats, so losing one of two {crlf} is caught", () => {
    expect(multisetDiff(multiset("a{crlf}b{crlf}", PLACEHOLDER_RE), multiset("a{crlf}b", PLACEHOLDER_RE))).toEqual([
      "{crlf}: 2→1",
    ]);
  });
});

describe("tags", () => {
  it("ignores whitespace inside the tag but not a missing tag", () => {
    expect(multisetDiff(tagNames("<b>x</b>"), tagNames("<b> y </b>"))).toEqual([]);
    expect(multisetDiff(tagNames("<b>x</b>"), tagNames("x"))).toEqual(["</b>: 1→0", "<b>: 1→0"]);
  });
});

describe("folding", () => {
  it("removes Polish diacritics including ł", () => {
    expect(fold("Wyślij Łącznie ŻÓŁĆ")).toBe("wyslij lacznie zolc");
  });

  it("collapses spacing and punctuation only under foldHard", () => {
    expect(fold("VAT (%)")).not.toBe(fold("VAT(%)"));
    expect(foldHard("VAT (%)")).toBe(foldHard("VAT(%)"));
  });

  it("calls spacing-only variants trivially equivalent", () => {
    expect(triviallyEquivalent(["VAT (%)", "VAT(%)"])).toBe(true);
    expect(triviallyEquivalent(["MwSt. (%)", "MwSt (%)"])).toBe(true);
    expect(triviallyEquivalent(["Senden", "Schicken"])).toBe(false);
    expect(triviallyEquivalent(["Löschen", "Entfernen"])).toBe(false);
  });
});

describe("containsTerm", () => {
  it("respects word boundaries", () => {
    expect(containsTerm(fold("Podaj adres dostawy"), fold("adres"))).toBe(true);
    expect(containsTerm(fold("Kod adresowy klienta"), fold("adres"))).toBe(false);
    expect(containsTerm(fold("Adres"), fold("adres"))).toBe(true);
  });

  it("matches a multi-word term", () => {
    expect(containsTerm(fold("Wpisz kod pocztowy odbiorcy"), fold("kod pocztowy"))).toBe(true);
  });
});

describe("replaceTerm", () => {
  it("replaces whole words only and reports the count", () => {
    expect(replaceTerm("Schranke Nr. {0} gespeichert", "Schranke", "Tor")).toEqual({
      text: "Tor Nr. {0} gespeichert",
      count: 1,
    });
    expect(replaceTerm("Schrankenwärter", "Schranke", "Tor").count).toBe(0);
  });

  it("preserves the case shape of the occurrence", () => {
    expect(replaceTerm("SCHRANKE öffnen", "Schranke", "Tor").text).toBe("TOR öffnen");
    expect(replaceTerm("die schranke", "Schranke", "Tor").text).toBe("die tor");
  });

  it("leaves the string alone when the term is absent", () => {
    expect(replaceTerm("Tor Nr. {0}", "Schranke", "Tor")).toEqual({ text: "Tor Nr. {0}", count: 0 });
  });
});

describe("shape helpers", () => {
  it("classifies casing", () => {
    expect(caseShape("ADRES")).toBe("upper");
    expect(caseShape("adres")).toBe("lower");
    expect(caseShape("Adres Dostawy")).toBe("title");
    expect(caseShape("Adres dostawy klienta")).toBe("sentence");
  });

  it("ignores placeholders when classifying", () => {
    expect(caseShape("{0} ADRES")).toBe("upper");
  });

  it("finds terminal punctuation past a trailing placeholder", () => {
    expect(terminalPunct("Zapisano.{crlf}")).toBe(".");
    expect(terminalPunct("Zapisano{crlf}")).toBe("");
  });

  it("counts words without placeholders or markup", () => {
    expect(wordCount("<b>Cena {0} netto</b>")).toBe(2);
  });

  it("spots identifier-shaped sources", () => {
    expect(looksLikeIdentifier("WidthX")).toBe(true);
    expect(looksLikeIdentifier("ktm_b2100")).toBe(true);
    expect(looksLikeIdentifier("TypElementuSkrzydla.symbol~DZ~nazwa")).toBe(true);
    expect(looksLikeIdentifier("A5200")).toBe(true);
    expect(looksLikeIdentifier("Cena netto")).toBe(false);
    expect(looksLikeIdentifier("ADRES")).toBe(false);
    expect(looksLikeIdentifier("VAT")).toBe(false);
    expect(looksLikeIdentifier("Usuń")).toBe(false);
    expect(looksLikeIdentifier("Ok")).toBe(false);
  });

  it("matchCase does not capitalise a mixed sample", () => {
    expect(matchCase("iPhone x", "tor")).toBe("tor");
  });
});
