import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Question } from "../src/jev/client.ts";
import type { Envelope } from "../src/report/envelope.ts";

/**
 * The warm loop, across processes.
 *
 * `evidence.test.ts` proves the store works inside one process. That is not the claim the
 * README makes. *"The second run of anything is nearly free"* is a claim about a run you
 * start tomorrow, from a shell, against a file written by a run that has already exited —
 * and the way it fails is silent: one field in the state that varies per process (a
 * timestamp, a set iterated in a different order, a locale-dependent sort) makes every
 * fingerprint a miss and quietly restores the whole bill.
 *
 * So this runs the real CLI twice, as two child processes, against a stub endpoint that
 * counts what it is asked. It is stage 11's acceptance against a synthetic corpus: what is
 * left for the paid run is the real corpus and the real endpoint, not the mechanism.
 */
const exec = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const NODE_ARGS = ["--experimental-strip-types", "--no-warnings", resolve(ROOT, "src/cli.ts")];

const dirs: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Answers anything, and remembers how many times it was asked. */
async function stubEndpoint(): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits++;
      const { questions } = JSON.parse(body) as { questions: Record<string, Question> };
      const answers: Record<string, unknown> = {};
      for (const [name, q] of Object.entries(questions)) {
        if (q.type === "noul") answers[name] = { type: "noul", noul: 0.9 };
        else if (q.type === "choice") {
          const first = Object.keys(q.criteria)[0];
          answers[name] = { type: "choice", choice: first, probabilities: { [first]: 0.9 }, confidence: 0.9 };
        } else answers[name] = { type: "score", score: 1, legend: {}, probabilities: {}, confidence: 0.9 };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "stub", answers, usage: { input_tokens: 120, output_tokens: 30 } }));
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits };
}

describe("a second run of the same thing", () => {
  it("makes no requests, spends nothing, and reuses exactly what the first one bought", async () => {
    const stub = await stubEndpoint();
    const dir = mkdtempSync(join(tmpdir(), "warm-"));
    dirs.push(dir);
    const out = join(dir, "audit.xlsx");
    const args = [...NODE_ARGS, "run", "--synthetic", "60", "--langs", "de,uk", "--out", out, "--json"];
    const env = {
      ...process.env,
      TYPESAFE_API_KEY: "stub",
      TYPESAFE_BASE_URL: stub.url,
      JEV_CONCURRENCY: "6",
    };

    const cold = JSON.parse((await exec(process.execPath, args, { cwd: ROOT, env })).stdout) as Envelope;
    expect(cold.ok).toBe(true);
    expect(cold.cost!.requests).toBeGreaterThan(0);
    expect(cold.cost!.reused).toBe(0);
    expect(cold.cost!.usd).toBeGreaterThan(0);
    expect(stub.hits()).toBe(cold.cost!.requests);
    expect(existsSync(join(dir, "audit.evidence.jsonl"))).toBe(true);

    const bought = stub.hits();
    const warm = JSON.parse((await exec(process.execPath, args, { cwd: ROOT, env })).stdout) as Envelope;

    // stage 11's acceptance, word for word
    expect(warm.cost!.requests).toBe(0);
    expect(warm.cost!.usd).toBe(0);
    expect(warm.cost!.reused).toBe(cold.cost!.requests);
    // and the endpoint can confirm it: not one connection was made
    expect(stub.hits()).toBe(bought);

    // the run is not merely cheap, it is the same run
    expect(warm.counts!.findings).toBe(cold.counts!.findings);
    expect(warm.counts!["exact defects"]).toBe(cold.counts!["exact defects"]);
    expect(warm.counts!["glossary terms"]).toBe(cold.counts!["glossary terms"]);
    expect(warm.coverage).toEqual(cold.coverage);
  }, 180_000);

  it("prices the remainder at zero before spending it, and says so per stage", async () => {
    const stub = await stubEndpoint();
    const dir = mkdtempSync(join(tmpdir(), "warm-plan-"));
    dirs.push(dir);
    const out = join(dir, "audit.xlsx");
    const env = { ...process.env, TYPESAFE_API_KEY: "stub", TYPESAFE_BASE_URL: stub.url, JEV_CONCURRENCY: "6" };
    const source = ["--synthetic", "40", "--langs", "de", "--out", out];

    const before = JSON.parse(
      (await exec(process.execPath, [...NODE_ARGS, "plan", ...source, "--json"], { cwd: ROOT, env })).stdout,
    ) as Envelope;
    expect(stub.hits()).toBe(0); // looking is free: `plan` opened no connection
    const willBuy = Number(before.counts!["requests to make"]);
    expect(willBuy).toBeGreaterThan(0);

    await exec(process.execPath, [...NODE_ARGS, "run", ...source, "--json"], { cwd: ROOT, env });

    const after = JSON.parse(
      (await exec(process.execPath, [...NODE_ARGS, "plan", ...source, "--json"], { cwd: ROOT, env })).stdout,
    ) as Envelope;
    const spent = stub.hits();
    expect(Number(after.counts!["requests to make"])).toBe(0);
    expect(Number(after.counts!["already bought"])).toBe(willBuy);
    expect(spent).toBe(willBuy); // and the estimate was exact, not approximate

    // every judgment in the file is addressed, and no address appears twice
    const lines = readFileSync(join(dir, "audit.evidence.jsonl"), "utf8").trim().split("\n");
    const fps = lines.map((l) => (JSON.parse(l) as { fp: string }).fp);
    expect(fps.every((f) => f.length === 32)).toBe(true);
    expect(new Set(fps).size).toBe(fps.length);
  }, 180_000);
});
