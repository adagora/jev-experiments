import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flagNum, type Args } from "./args.ts";

/**
 * Everything the pipeline is configured by, in one place.
 *
 * Before this existed the domain sentence was written four times and one copy —
 * the one `score` used — said something different, so the pipeline being measured
 * was not the pipeline being shipped. One profile, read by `run`, `score`, `probe`
 * and the review server, is what makes a measurement describe the real system.
 */

/** Thresholds that turn judgments into findings. Policy, never inference. */
export type Policy = {
  meaningBad: number;
  meaningDoubtful: number;
  adherenceBad: number;
  uiStringMin: number;
  registerMinSample: number;
  registerMinDominance: number;
  registerMinConfidence: number;
  canonicalConfidence: number;
};

export const DEFAULT_POLICY: Policy = {
  meaningBad: 0.35,
  meaningDoubtful: 0.7,
  adherenceBad: 0.4,
  uiStringMin: 0.25,
  registerMinSample: 25,
  registerMinDominance: 0.8,
  registerMinConfidence: 0.6,
  canonicalConfidence: 0.6,
};

/** A mechanical substitution is offered only when it clears all three. */
export type SubstitutionGates = {
  grammatical: number;
  preserved: number;
  improved: number;
};

export const DEFAULT_GATES: SubstitutionGates = {
  grammatical: 0.7,
  preserved: 0.8,
  improved: 0.6,
};

export type Pricing = { inputPerM: number; outputPerM: number };

export const DEFAULT_DOMAIN =
  "a B2B product configurator and order portal for building joinery (gates, doors, fences, windows)";

export type Profile = {
  domain: string;
  policy: Policy;
  gates: SubstitutionGates;
  model: string;
  baseUrl: string;
  pricing: Pricing;
  concurrency: number;
  /** Where the non-default values came from, so a run can say what it was configured by. */
  sources: string[];
};

export const CONFIG_FILE = "translate-audit.config.json";

export type ProfileFile = {
  domain?: string;
  policy?: Partial<Policy>;
  gates?: Partial<SubstitutionGates>;
  model?: string;
  baseUrl?: string;
  pricing?: Partial<Pricing>;
  concurrency?: number;
};

const POLICY_FLAGS: Record<string, keyof Policy> = {
  "meaning-bad": "meaningBad",
  "meaning-doubtful": "meaningDoubtful",
  "adherence-bad": "adherenceBad",
  "ui-string-min": "uiStringMin",
  "register-min-sample": "registerMinSample",
  "register-min-dominance": "registerMinDominance",
  "register-min-confidence": "registerMinConfidence",
  "canonical-confidence": "canonicalConfidence",
};

const GATE_FLAGS: Record<string, keyof SubstitutionGates> = {
  "gate-grammatical": "grammatical",
  "gate-preserved": "preserved",
  "gate-improved": "improved",
};

export function readProfileFile(dir = process.cwd()): { file: ProfileFile; path: string } | null {
  const path = resolve(dir, CONFIG_FILE);
  if (!existsSync(path)) return null;
  try {
    return { file: JSON.parse(readFileSync(path, "utf8")) as ProfileFile, path };
  } catch (e) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Defaults, then the config file, then the environment, then CLI flags.
 * Later layers win, and every layer that changed something is named in `sources`.
 */
export function loadProfile(args?: Args, dir = process.cwd()): Profile {
  const sources: string[] = [];

  const profile: Profile = {
    domain: DEFAULT_DOMAIN,
    policy: { ...DEFAULT_POLICY },
    gates: { ...DEFAULT_GATES },
    model: "jev-latest",
    baseUrl: "https://api.typesafe.ai/v1/systemone",
    pricing: { inputPerM: 0.4, outputPerM: 2.0 },
    concurrency: 12,
    sources,
  };

  const found = readProfileFile(dir);
  if (found) {
    const f = found.file;
    if (f.domain !== undefined) profile.domain = f.domain;
    if (f.model !== undefined) profile.model = f.model;
    if (f.baseUrl !== undefined) profile.baseUrl = f.baseUrl;
    if (f.concurrency !== undefined) profile.concurrency = f.concurrency;
    Object.assign(profile.policy, f.policy ?? {});
    Object.assign(profile.gates, f.gates ?? {});
    Object.assign(profile.pricing, f.pricing ?? {});
    sources.push(CONFIG_FILE);
  }

  const env = process.env;
  let fromEnv = false;
  const takeEnv = (name: string, apply: (v: string) => void): void => {
    const v = env[name];
    if (v === undefined || v === "") return;
    apply(v);
    fromEnv = true;
  };
  takeEnv("JEV_MODEL", (v) => (profile.model = v));
  takeEnv("TYPESAFE_BASE_URL", (v) => (profile.baseUrl = v));
  takeEnv("JEV_PRICE_IN", (v) => Number.isFinite(Number(v)) && (profile.pricing.inputPerM = Number(v)));
  takeEnv("JEV_PRICE_OUT", (v) => Number.isFinite(Number(v)) && (profile.pricing.outputPerM = Number(v)));
  takeEnv("JEV_CONCURRENCY", (v) => Number.isFinite(Number(v)) && (profile.concurrency = Number(v)));
  takeEnv("TRANSLATE_AUDIT_DOMAIN", (v) => (profile.domain = v));
  if (fromEnv) sources.push("environment");

  if (args) {
    let fromFlags = false;
    const domain = args.flags.get("domain");
    if (domain && domain !== "true") {
      profile.domain = domain;
      fromFlags = true;
    }
    for (const [flag, key] of Object.entries(POLICY_FLAGS)) {
      if (!args.flags.has(flag)) continue;
      profile.policy[key] = flagNum(args, flag, profile.policy[key]);
      fromFlags = true;
    }
    for (const [flag, key] of Object.entries(GATE_FLAGS)) {
      if (!args.flags.has(flag)) continue;
      profile.gates[key] = flagNum(args, flag, profile.gates[key]);
      fromFlags = true;
    }
    if (args.flags.has("concurrency")) {
      profile.concurrency = flagNum(args, "concurrency", profile.concurrency);
      fromFlags = true;
    }
    if (fromFlags) sources.push("flags");
  }

  return profile;
}

/** The one-line statement of what this profile decides, for a report or a run record. */
export const policyNote = (p: Policy, g: SubstitutionGates): string =>
  `meaning < ${p.meaningBad} = defect, < ${p.meaningDoubtful} = doubtful; glossary adherence < ${p.adherenceBad}; ` +
  `non-UI strings below p=${p.uiStringMin} get cosmetic checks only; formality drift needs a house register at least ` +
  `${Math.round(p.registerMinDominance * 100)}% dominant over ${p.registerMinSample}+ addressing strings; a substitution is ` +
  `offered only when it clears grammar ${g.grammatical.toFixed(2)}, meaning ${g.preserved.toFixed(2)} and ` +
  `improvement ${g.improved.toFixed(2)}. ` +
  `Change any of these with "translate-audit report <run.json> --meaning-bad 0.2": it re-composes the saved judgments, free.`;
