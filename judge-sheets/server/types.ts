/** TypeSafe question/answer shapes plus typed builders. Pure — shared by server and browser. */

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
};
export type ChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
};
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type SystemOneResponse = {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
};

export const noul = (instructions: string): NoulQuestion => ({ type: "noul", instructions });
export const choice = (instructions: string, options: string[]): ChoiceQuestion => ({
  type: "choice",
  instructions,
  criteria: Object.fromEntries(options.map((o) => [o, null])),
});
export const score = (instructions: string, levels: string[]): ScoreQuestion => ({
  type: "score",
  instructions,
  criteria: levels,
});

/** One line of the /api/judge NDJSON stream. */
export type JudgeLine =
  | { id: string; answers: Record<string, Answer>; ms: number; attempts: number; mock?: boolean; usage?: SystemOneResponse["usage"] }
  | { id: string; error: string; status: number }
  | { done: true; totalMs: number; requests: number };
