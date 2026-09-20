/**
 * Tiny proxy in front of TypeSafe. The browser never sees the API key.
 *
 *   POST /api/judge   { requests: [{ id, state, questions }] }
 *                     -> NDJSON stream, one line per finished request:
 *                        { id, answers, ms, attempts } | { id, error, status }
 *                        then a final { done: true, totalMs, requests }
 *   GET  /api/health  { ok, mode: "live" | "mock" | "nokey", model, concurrency }
 *
 * MOCK=1 replays answers recorded in server/mock-answers.json (the UI shows a
 * MOCK banner). RECORD=1 appends live answers to that file.
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { systemOne, JevError, MODEL } from "./jev.ts";
import type { Question, Answer } from "./types.ts";
import { runPool } from "./pool.ts";
import { mockAnswers } from "./mock.ts";

const PORT = Number(process.env.PORT ?? 8787);
const CONCURRENCY = Number(process.env.JEV_CONCURRENCY ?? 12);
const MOCK = process.env.MOCK === "1";
const RECORD = process.env.RECORD === "1";
const API_KEY = process.env.TYPESAFE_API_KEY ?? "";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_FILE = join(here, "mock-answers.json");
type Recorded = Record<string, Record<string, Answer>>;
const recorded: Recorded = existsSync(MOCK_FILE)
  ? (JSON.parse(readFileSync(MOCK_FILE, "utf8")) as Recorded)
  : {};

const mode = MOCK ? "mock" : API_KEY ? "live" : "nokey";
if (mode === "nokey") {
  console.error(
    "\n  TYPESAFE_API_KEY is not set. Export it (or run with MOCK=1 for a clearly-labelled replay).\n",
  );
}

type JudgeRequest = { id: string; state: unknown; questions: Record<string, Question> };

const keyOf = (state: unknown, questions: Record<string, Question>) =>
  createHash("sha1").update(JSON.stringify({ state, questions })).digest("hex");

async function judgeOne(req: JudgeRequest) {
  if (MOCK) {
    const t0 = performance.now();
    const hit = recorded[keyOf(req.state, req.questions)];
    const answers = hit ?? mockAnswers(req.state, req.questions);
    return { id: req.id, answers, ms: performance.now() - t0, attempts: 1, mock: true };
  }
  const { response, ms, attempts } = await systemOne(API_KEY, req.state, req.questions);
  if (RECORD) recorded[keyOf(req.state, req.questions)] = response.answers;
  return { id: req.id, answers: response.answers, ms, attempts, usage: response.usage };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  if (req.method === "GET" && req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, mode, model: MODEL, concurrency: CONCURRENCY }));
  }

  if (req.method === "POST" && req.url === "/api/judge") {
    if (mode === "nokey") {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "TYPESAFE_API_KEY is not set on the server" }));
    }
    let requests: JudgeRequest[];
    try {
      requests = (JSON.parse(await readBody(req)) as { requests: JudgeRequest[] }).requests;
      if (!Array.isArray(requests)) throw new Error("requests must be an array");
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: String(e) }));
    }
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    const t0 = performance.now();
    await runPool(
      requests,
      CONCURRENCY,
      async (r) => {
        try {
          return await judgeOne(r);
        } catch (e) {
          const status = e instanceof JevError ? e.status : 0;
          return { id: r.id, error: e instanceof Error ? e.message : String(e), status };
        }
      },
      (line) => res.write(JSON.stringify(line) + "\n"),
    );
    if (RECORD) writeFileSync(MOCK_FILE, JSON.stringify(recorded));
    res.end(
      JSON.stringify({ done: true, totalMs: performance.now() - t0, requests: requests.length }) +
        "\n",
    );
    return;
  }

  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(
    `judge-sheets proxy on http://localhost:${PORT}  mode=${mode}  model=${MODEL}  concurrency=${CONCURRENCY}`,
  );
});
