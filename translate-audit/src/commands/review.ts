import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../server/index.ts";

export type ReviewArgs = {
  cache: string;
  glossary?: string;
  decisions?: string;
  port: number;
  apiKey?: string;
  concurrency?: number;
  open?: boolean;
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

export async function runReview(args: ReviewArgs): Promise<void> {
  const paths = resolvePaths(args);
  if (!existsSync(paths.cache)) {
    throw new Error(`no such run: ${paths.cache} — produce one with "translate-audit run ... --save ${paths.cache}"`);
  }

  const staticDir = findStaticDir();
  const { server, session } = createServer({
    paths,
    port: args.port,
    staticDir,
    apiKey: args.apiKey,
    concurrency: args.concurrency,
  });

  const stats = session.stats();
  await new Promise<void>((res) => server.listen(args.port, res));

  console.log(`\n  review server on http://localhost:${args.port}`);
  console.log(`  ${paths.cache}`);
  console.log(`  glossary  ${paths.glossary}${existsSync(paths.glossary) ? "" : "  (new)"}`);
  console.log(`  decisions ${paths.decisions}${existsSync(paths.decisions) ? "" : "  (new)"}`);
  console.log(
    `\n  ${stats.summary.findings.toLocaleString()} findings · ` +
      `${stats.glossary.total.toLocaleString()} glossary terms (${stats.glossary.decided} decided) · ` +
      `${stats.decisions.total.toLocaleString()} decisions so far`,
  );
  if (!args.apiKey) console.log("\n  ! TYPESAFE_API_KEY is not set — live checks on edited text are disabled.");
  if (!staticDir) {
    console.log(`\n  ! No built UI at web-dist. Run "npm run build:web", or use "npm run review:dev" for hot reload.`);
  }
  console.log("");
}
