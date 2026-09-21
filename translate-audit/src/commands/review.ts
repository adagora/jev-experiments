import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../server/index.ts";
import { loadProfile, type Profile } from "../config/profile.ts";
import { note, type Warning } from "../report/envelope.ts";
import type { Session, SessionPaths } from "../../server/api.ts";

export type ReviewArgs = {
  cache: string;
  glossary?: string;
  decisions?: string;
  port: number;
  apiKey?: string;
  concurrency?: number;
  open?: boolean;
  profile?: Profile;
};

export type ReviewStarted = {
  paths: SessionPaths;
  stats: ReturnType<Session["stats"]>;
  warnings: Warning[];
};

export function resolvePaths(args: ReviewArgs) {
  const base = args.cache.replace(/\.run\.json$|\.json$/, "");
  return {
    cache: args.cache,
    glossary: args.glossary ?? `${base}.glossary.json`,
    decisions: args.decisions ?? `${base}.decisions.json`,
  };
}

export function findStaticDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = resolve(here, "../../web-dist");
  return existsSync(join(dist, "index.html")) ? dist : undefined;
}

export async function runReview(args: ReviewArgs): Promise<ReviewStarted> {
  const paths = resolvePaths(args);
  if (!existsSync(paths.cache)) {
    throw new Error(`no such run: ${paths.cache} — produce one with "translate-audit run ... --save ${paths.cache}"`);
  }

  const staticDir = findStaticDir();
  const profile = args.profile ?? loadProfile();
  const { server, session } = createServer({
    paths,
    port: args.port,
    staticDir,
    apiKey: args.apiKey,
    concurrency: args.concurrency,
    profile,
  });

  const stats = session.stats();
  await new Promise<void>((res) => server.listen(args.port, res));

  const warnings: Warning[] = [];
  if (!args.apiKey) {
    warnings.push({ code: "no-api-key", detail: "TYPESAFE_API_KEY is not set — live checks on edited text are disabled" });
  }
  if (!staticDir) {
    warnings.push({
      code: "no-built-ui",
      detail: 'no built UI at web-dist. Run "npm run build:web", or use "npm run review:dev" for hot reload',
    });
  }

  note(`\n  review server on http://localhost:${args.port}`);
  note(`  ${paths.cache}`);
  note(`  glossary  ${paths.glossary}${existsSync(paths.glossary) ? "" : "  (new)"}`);
  note(`  decisions ${paths.decisions}${existsSync(paths.decisions) ? "" : "  (new)"}`);
  for (const w of warnings) note(`  ! ${w.detail}`);

  return { paths, stats, warnings };
}
