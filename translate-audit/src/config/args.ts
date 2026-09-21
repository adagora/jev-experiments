import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function loadEnv(from = process.cwd()): void {
  let dir = resolve(from);
  for (let i = 0; i < 6; i++) {
    const p = join(dir, ".env");
    if (existsSync(p)) {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq < 0) continue;
        const k = t.slice(0, eq).trim();
        const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!(k in process.env)) process.env[k] = v;
      }
      return;
    }
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

export type Args = {
  command: string;
  flags: Map<string, string>;
  positional: string[];
};

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "run";
  for (let i = command === argv[0] ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags.set(a.slice(2), argv[++i]);
    } else {
      flags.set(a.slice(2), "true");
    }
  }
  return { command, flags, positional };
}

export const flagList = (args: Args, name: string): string[] => {
  const v = args.flags.get(name);
  return v && v !== "true" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
};

export const flagNum = (args: Args, name: string, fallback: number): number => {
  const v = args.flags.get(name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * `--fix` / `--fix false` / `--no-fix`.
 *
 * The `--no-` form is the one people actually type, and it used to be parsed into a flag
 * called `no-fix` that nothing ever read — so `--no-fix`, documented as a way to skip the
 * substitution stage, silently spent the requests anyway.
 */
export const flagBool = (args: Args, name: string, fallback: boolean): boolean => {
  if (args.flags.has(`no-${name}`)) return false;
  const v = args.flags.get(name);
  if (v === undefined) return fallback;
  return v !== "false" && v !== "0";
};
