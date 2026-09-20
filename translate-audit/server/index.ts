import http from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize as normalizePath, resolve } from "node:path";
import { Session, type SessionPaths } from "./api.ts";
import { JevClient } from "../src/jev/client.ts";
import type { Verdict } from "../src/review/decisions.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

export type ServeOptions = {
  paths: SessionPaths;
  port: number;
  staticDir?: string;
  apiKey?: string;
  concurrency?: number;
};

const csvCell = (s: string): string => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function createServer(opts: ServeOptions): { server: http.Server; session: Session } {
  const client = opts.apiKey ? new JevClient({ apiKey: opts.apiKey, concurrency: opts.concurrency ?? 6 }) : null;
  const session = new Session(opts.paths, client);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.writeHead(204).end();

    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const num = (k: string): number | undefined => {
      const v = url.searchParams.get(k);
      return v === null || v === "" ? undefined : Number(v);
    };
    const str = (k: string): string | undefined => url.searchParams.get(k) ?? undefined;

    try {
      if (req.method === "GET" && p === "/api/meta") return json(200, session.meta());
      if (req.method === "GET" && p === "/api/stats") return json(200, session.stats());

      if (req.method === "GET" && p === "/api/rows") {
        return json(
          200,
          session.rows({
            lang: str("lang"),
            category: str("category"),
            project: str("project"),
            minSeverity: num("minSeverity"),
            undecidedOnly: url.searchParams.get("undecidedOnly") === "1",
            q: str("q"),
            offset: num("offset"),
            limit: num("limit"),
          }),
        );
      }

      if (req.method === "GET" && p.startsWith("/api/entry/")) {
        const e = session.entry(decodeURIComponent(p.slice("/api/entry/".length)));
        return e ? json(200, e) : json(404, { error: "no such key" });
      }

      if (req.method === "GET" && p === "/api/glossary") {
        return json(
          200,
          session.glossaryRows({
            lang: str("lang"),
            status: str("status"),
            q: str("q"),
            offset: num("offset"),
            limit: num("limit"),
          }),
        );
      }

      if (req.method === "GET" && p === "/api/export.csv") {
        const rows = session.exportChanges();
        const lines = ["key_id,key_name,language_iso,translation,previous_translation"];
        for (const r of rows) lines.push([r.entryId, r.keyName, r.lang, r.after, r.before].map(csvCell).join(","));
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="lokalise-reimport.csv"',
        });
        return res.end("﻿" + lines.join("\n") + "\n");
      }

      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        const who = String(body.who ?? "anonymous");

        if (p === "/api/decision") {
          const rec = session.putDecision({
            entryId: String(body.entryId),
            lang: String(body.lang),
            verdict: String(body.verdict) as Verdict,
            text: body.text === undefined ? undefined : String(body.text),
            note: body.note === undefined ? undefined : String(body.note),
            check: (body.check as { meaning: number; grammatical: number } | undefined) ?? null,
            who,
          });
          return rec ? json(200, { decision: rec, stats: session.stats() }) : json(404, { error: "no such key" });
        }

        if (p === "/api/decision/clear") {
          session.clearDecision(String(body.entryId), String(body.lang));
          return json(200, { ok: true, stats: session.stats() });
        }

        if (p.startsWith("/api/glossary/")) {
          const key = decodeURIComponent(p.slice("/api/glossary/".length));
          const rec = session.patchTerm(
            key,
            {
              canonical: body.canonical === undefined ? undefined : (body.canonical as string | null),
              status: body.status as never,
              guidance: body.guidance === undefined ? undefined : String(body.guidance),
              note: body.note === undefined ? undefined : String(body.note),
            },
            who,
          );
          return rec ? json(200, { term: rec, stats: session.stats() }) : json(404, { error: "no such term" });
        }

        if (p === "/api/glossary") {
          const rec = session.addTerm({
            term: String(body.term),
            lang: String(body.lang),
            canonical: String(body.canonical),
            guidance: body.guidance === undefined ? undefined : String(body.guidance),
            who,
          });
          return json(200, { term: rec, stats: session.stats() });
        }

        if (p === "/api/check") {
          const r = await session.checkEdit({
            entryId: String(body.entryId),
            lang: String(body.lang),
            text: String(body.text),
          });
          return json(200, r);
        }

        if (p.startsWith("/api/arbitrate/")) {
          const key = decodeURIComponent(p.slice("/api/arbitrate/".length));
          return json(200, await session.arbitrateTerm(key));
        }

        if (p === "/api/policy") {
          return json(200, { policy: session.setPolicy(body as never), stats: session.stats() });
        }
      }

      if (p.startsWith("/api/")) return json(404, { error: "no such route" });

      if (opts.staticDir && req.method === "GET") {
        const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
        const file = resolve(opts.staticDir, normalizePath(rel));
        if (!file.startsWith(resolve(opts.staticDir))) return json(403, { error: "nope" });
        const target = existsSync(file) && statSync(file).isFile() ? file : join(opts.staticDir, "index.html");
        if (existsSync(target)) {
          res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "application/octet-stream" });
          return res.end(readFileSync(target));
        }
      }

      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    } catch (e) {
      json(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  return { server, session };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve_, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve_(data));
    req.on("error", reject);
  });
}
