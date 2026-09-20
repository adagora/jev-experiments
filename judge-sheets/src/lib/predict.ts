/**
 * Predictive columns. The user types a column header ("Urgency", "Refund
 * risk?", "Topic"); Jev classifies what kind of judgment that header asks for
 * (keystroke intent), and the column is filled with the matching JUDGE / PICK /
 * RATE formula for every row of the sheet's text column. Everything here is
 * pure except `classifyIntent`, which makes one measured /api/judge call.
 */
import { colToName } from "../engine/refs.ts";
import { choice, type JudgeLine } from "../../server/types.ts";
import type { JevKind } from "../engine/values.ts";

export type Schema = {
  id: string;
  /** Short label shown in the intent chip and the smart-fill card. */
  label: string;
  /** How the option is described to Jev when it classifies the header. */
  describe: string;
  kind: JevKind;
  /** Instructions sent with every cell. `{header}` is replaced by the typed header. */
  instructions: string;
  options: string[];
};

export const SCHEMAS: Schema[] = [
  {
    id: "sentiment",
    label: "Sentiment",
    describe: "sentiment / how positive or negative the text is",
    kind: "rate",
    instructions: "Overall sentiment of this text",
    options: ["very negative", "negative", "neutral", "positive", "very positive"],
  },
  {
    id: "urgency",
    label: "Urgency",
    describe: "urgency / how quickly someone needs to follow up",
    kind: "rate",
    instructions: "How urgent is it for our team to follow up with this person?",
    options: ["no follow-up needed", "low", "medium", "high", "urgent"],
  },
  {
    id: "topic",
    label: "Topic",
    describe: "topic / category of a product review",
    kind: "pick",
    instructions: "What is the main topic of this text?",
    options: ["shipping", "quality", "price", "support", "other"],
  },
  {
    id: "intent",
    label: "Intent",
    describe: "intent of an inbound message / what the sender wants",
    kind: "pick",
    instructions: "This is an inbound message to a B2B software company. What does the sender want?",
    options: ["pricing", "demo request", "support", "partnership", "job inquiry", "spam"],
  },
  {
    id: "buying",
    label: "Buying intent",
    describe: "buying intent / how likely the sender is to purchase",
    kind: "rate",
    instructions: "How strong is the sender's intent to purchase our product?",
    options: ["no interest or unrelated", "curious, just exploring", "actively evaluating", "ready to buy now"],
  },
  {
    id: "tone",
    label: "Tone",
    describe: "emotional tone of the writer",
    kind: "pick",
    instructions: "What is the emotional tone of the writer?",
    options: ["angry", "disappointed", "neutral", "happy", "delighted"],
  },
  {
    id: "priority",
    label: "Priority",
    describe: "priority / severity for a support or ops team",
    kind: "rate",
    instructions: "How severe is the problem described, from a support team's point of view?",
    options: ["none", "low", "medium", "high", "critical"],
  },
  {
    id: "stars",
    label: "Star rating",
    describe: "star rating the author would give (1 to 5)",
    kind: "rate",
    instructions: "How many stars out of five would the author give?",
    options: ["1 star", "2 stars", "3 stars", "4 stars", "5 stars"],
  },
  {
    id: "defect",
    label: "Defect?",
    describe: "whether the text reports a defect, damage or malfunction",
    kind: "judge",
    instructions: "Does the text report a defect, damage or malfunction of the product itself?",
    options: [],
  },
  {
    id: "recommend",
    label: "Recommends?",
    describe: "whether the author would recommend the product",
    kind: "judge",
    instructions: "Would the author recommend the product to others?",
    options: [],
  },
  {
    id: "refund",
    label: "Refund risk?",
    describe: "whether the author is likely to return the product or ask for a refund",
    kind: "judge",
    instructions: "Is the author likely to return the product or ask for a refund?",
    options: [],
  },
  {
    id: "spam",
    label: "Spam?",
    describe: "whether the message is spam or unrelated",
    kind: "judge",
    instructions: "Is this message spam, a scam, or unrelated to the business?",
    options: [],
  },
  {
    id: "yesno",
    label: "Yes / no",
    describe: "some other yes/no question (the header itself is the question)",
    kind: "judge",
    instructions: "Answer this question about the text: {header}",
    options: [],
  },
  {
    id: "scale",
    label: "Low / high",
    describe: "some other quality rated low to high (the header names the quality)",
    kind: "rate",
    instructions: "Rate this text for: {header}",
    options: ["none", "low", "medium", "high", "very high"],
  },
];

export const schemaById = (id: string): Schema | undefined => SCHEMAS.find((s) => s.id === id);

export function instructionsFor(schema: Schema, header: string): string {
  const h = header.trim();
  return schema.instructions.replace("{header}", schema.id === "yesno" && !h.endsWith("?") ? `${h}?` : h);
}

/** The formula that a predicted cell holds, e.g. =RATE($C2,"...","a|b|c"). */
export function formulaFor(schema: Schema, header: string, textCol: number, row: number): string {
  const ref = `$${colToName(textCol)}${row + 1}`;
  const q = JSON.stringify(instructionsFor(schema, header));
  switch (schema.kind) {
    case "judge":
      return `=JUDGE(${ref},${q})`;
    case "pick":
      return `=PICK(${ref},${q},"${schema.options.join("|")}")`;
    case "rate":
      return `=RATE(${ref},${q},"${schema.options.join("|")}")`;
  }
}

export type Intent = {
  header: string;
  schema: Schema;
  confidence: number;
  probabilities: Record<string, number>;
  ms: number;
};

/** Pure: the question we ask Jev about a header. Exported for tests. */
export function intentQuestion() {
  return choice(
    "A spreadsheet user typed this column header above a column of free text. Which kind of prediction do they want in that column?",
    SCHEMAS.map((s) => s.describe),
  );
}

export function intentState(header: string, samples: string[]): string {
  const lines = samples.slice(0, 3).map((s) => `- ${s.length > 160 ? s.slice(0, 157) + "…" : s}`);
  return `Column header: "${header.trim()}"\n\nSample rows of the text column next to it:\n${lines.join("\n")}`;
}

export function pickSchema(probabilities: Record<string, number>): { schema: Schema; confidence: number } {
  let best = SCHEMAS[0];
  let p = -1;
  for (const s of SCHEMAS) {
    const q = probabilities[s.describe] ?? 0;
    if (q > p) {
      p = q;
      best = s;
    }
  }
  return { schema: best, confidence: Math.max(0, p) };
}

/** One measured request: what does this header mean? */
export async function classifyIntent(header: string, samples: string[], signal?: AbortSignal): Promise<Intent> {
  const t0 = performance.now();
  const res = await fetch("/api/judge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({ requests: [{ id: "intent", state: intentState(header, samples), questions: { q: intentQuestion() } }] }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const text = await res.text();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const j = JSON.parse(line) as JudgeLine;
    if ("done" in j) continue;
    if ("error" in j) throw new Error(j.error);
    const a = j.answers.q;
    if (!a || a.type !== "choice") throw new Error("unexpected answer");
    const { schema, confidence } = pickSchema(a.probabilities);
    return { header, schema, confidence, probabilities: a.probabilities, ms: performance.now() - t0 };
  }
  throw new Error("no answer");
}
