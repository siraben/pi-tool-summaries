import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readConfig } from "../src/config.js";
import { cleanSummary, Summaries } from "../src/summaries.js";

const config = { ...readConfig({}), timeoutMs: 20 };
const args = { command: "find src -name '*.ts' -print" };
const tick = () => delay(5);

test("settings validate malformed limits and model references", () => {
  assert.equal(readConfig({}).model, undefined);
  assert.throws(
    () => readConfig({ toolSummaries: { model: "cheap" } }),
    /provider/,
  );
  assert.throws(
    () => readConfig({ toolSummaries: { timeoutMs: "8000" } }),
    /integer/,
  );
  assert.throws(
    () => readConfig({ toolSummaries: { tools: ["bash"] } }),
    /Unknown/,
  );
  assert.throws(() => readConfig({ toolSummaries: { typo: true } }), /Unknown/);
  assert.equal(readConfig({}).reasoning, undefined);
  assert.equal(
    readConfig({ toolSummaries: { reasoning: "off" } }).reasoning,
    "off",
  );
  assert.equal(
    readConfig({ toolSummaries: { reasoning: "high" } }).reasoning,
    "high",
  );
  assert.throws(
    () => readConfig({ toolSummaries: { reasoning: "ultra" } }),
    /reasoning must/,
  );
  const config = readConfig({
    toolSummaries: { model: "openrouter/openai/example" },
  });
  assert.equal(config.provider, "openrouter");
  assert.equal(config.model, "openai/example");
  assert.equal(
    readConfig({ toolSummaries: { model: "current" } }).model,
    undefined,
  );
});

test("requests are asynchronous, deduplicated, and tied to exact call arguments", async () => {
  let resolve!: (value: string) => void;
  let requests = 0,
    renders = 0;
  const service = new Summaries(config, async (input) => {
    requests++;
    assert.deepEqual(JSON.parse(input), { tool: "bash", arguments: args });
    return new Promise((r) => {
      resolve = r;
    });
  });
  service.view("one", "bash", args, () => renders++);
  assert.equal(service.start("one", "bash", args), undefined);
  service.start("one", "bash", args);
  await tick();
  assert.equal(requests, 1);
  resolve(
    "Find TypeScript files under the source directory and print their paths.",
  );
  await tick();
  assert.equal(renders, 1);
  assert.match(
    service.view("one", "bash", args, () => {}).summary!,
    /TypeScript/,
  );
  assert.equal(
    service.view("one", "bash", { command: "rm file" }, () => {}).summary,
    undefined,
  );
  service.dispose();
});

test("timeouts abort providers even if they never resolve; failures remain original calls", async () => {
  let signal!: AbortSignal;
  const service = new Summaries(config, async (_input, s) => {
    signal = s;
    return new Promise(() => {});
  });
  service.start("timeout", "bash", args);
  await delay(40);
  assert.ok(signal.aborted);
  assert.equal(
    service.view("timeout", "bash", args, () => {}).status,
    "unavailable",
  );
  service.dispose();
  const failed = new Summaries(config, async () => {
    throw new Error("secret key must not leak");
  });
  failed.start("error", "bash", args);
  await tick();
  assert.equal(failed.view("error", "bash", args, () => {}).summary, undefined);
  assert.doesNotMatch(failed.lastIssue!, /secret/);
});

test("oversized and excess parallel calls do not get truncated or sent", async () => {
  let requests = 0;
  const service = new Summaries(
    { ...config, maxInputChars: 100, concurrency: 1 },
    async () => {
      requests++;
      return new Promise(() => {});
    },
  );
  service.start("large", "bash", { command: "x".repeat(101) });
  service.start("first", "bash", args);
  service.start("busy", "bash", args);
  await tick();
  assert.equal(requests, 1);
  assert.equal(
    service.view("busy", "bash", args, () => {}).status,
    "unavailable",
  );
  service.dispose();
});

test("session disposal and parent cancellation prevent late UI updates", async () => {
  const controller = new AbortController();
  let invalidations = 0;
  const service = new Summaries(config, async () => new Promise(() => {}));
  service.view("abort", "bash", args, () => invalidations++);
  service.start("abort", "bash", args, controller.signal);
  controller.abort();
  service.dispose();
  await tick();
  assert.equal(invalidations, 0);
});

test("model text cannot inject terminal escapes or bidirectional controls", () => {
  assert.equal(cleanSummary("\x1b[31mRead\x1b[0m\nfiles\u202e"), "Read files");
});
