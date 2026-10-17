import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config.js";
import { Summaries } from "../src/summaries.js";
import { setTimeout as delay } from "node:timers/promises";

test("privacy settings validate bounded literal exclusions and booleans", () => {
  assert.equal(readConfig().enabled, true);
  assert.deepEqual(readConfig().exclude, []);
  for (const enabled of [0, "false", null])
    assert.throws(() => readConfig({ toolSummaries: { enabled } }), /enabled/);
  for (const exclude of [
    "secret",
    [""],
    [42],
    ["x".repeat(1001)],
    Array(101).fill("x"),
    null,
  ])
    assert.throws(() => readConfig({ toolSummaries: { exclude } }), /exclude/);
  assert.deepEqual(
    readConfig({ toolSummaries: { exclude: ["[literal.*]", "private"] } })
      .exclude,
    ["[literal.*]", "private"],
  );
});

test("privacy exclusions cover all arguments in live and forced backfill without network calls", async () => {
  let calls = 0;
  const generate = async () => {
    calls++;
    return "Reading files.";
  };
  const config = readConfig({
    toolSummaries: { exclude: ["private", "[literal.*]"] },
  });
  const service = new Summaries(config, generate);
  const args = { command: "printf harmless", metadata: "private" };
  service.start("live", "bash", args);
  assert.equal(
    await service.backfill("old", "bash", args, generate, true),
    "skipped",
  );
  service.start("literal", "codemode", { code: "text('[literal.*]');" });
  await delay(5);
  assert.equal(calls, 0);
  service.start("public", "bash", { command: "printf PUBLIC" });
  await delay(5);
  assert.equal(calls, 1);
  config.enabled = false;
  service.start("disabled", "bash", { command: "printf hello" });
  assert.equal(
    await service.backfill("paused", "bash", {}, generate),
    "cancelled",
  );
  await delay(5);
  assert.equal(calls, 1);
  service.dispose();
});

test("pause cancels in-flight work, preserves saved summaries, and permits new calls on resume", async () => {
  const config = readConfig();
  const saved: unknown[] = [];
  const service = new Summaries(
    config,
    async () => "Reading files.",
    (record) => saved.push(record),
  );
  const args = { command: "printf example" };
  service.start("ready", "bash", args);
  await delay(5);
  let finish!: (text: string) => void;
  service.start(
    "pending",
    "bash",
    args,
    undefined,
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await delay(5);
  config.enabled = false;
  service.cancelAll();
  await delay(5);
  finish("Late private summary.");
  await delay(5);
  assert.equal(saved.length, 1);
  assert.equal(
    service.view("ready", "bash", args, () => {}).summary,
    "Reading files.",
  );
  assert.equal(
    service.view("pending", "bash", args, () => {}).status,
    "unavailable",
  );
  config.enabled = true;
  service.start("resumed", "bash", args);
  await delay(5);
  assert.equal(saved.length, 2);
  service.dispose();
});

test("backfill cancellation interrupts capacity waiting without cancelling live work", async () => {
  const config = { ...readConfig(), concurrency: 1 };
  const service = new Summaries(config, async () => new Promise(() => {}));
  const args = { command: "printf example" };
  service.start("live", "bash", args);
  const controller = new AbortController();
  let calls = 0;
  const backfill = service.backfill(
    "waiting",
    "bash",
    args,
    async () => {
      calls++;
      return "Reading files.";
    },
    false,
    controller.signal,
  );
  controller.abort();
  assert.equal(await backfill, "cancelled");
  assert.equal(calls, 0);
  assert.equal(service.view("live", "bash", args, () => {}).status, "pending");
  service.dispose();
});
