import assert from "node:assert/strict";
import { test } from "node:test";
import { Summaries, type SavedSummary } from "../src/summaries.js";
import { readConfig } from "../src/config.js";
import { deferred } from "./helpers.js";

const args = { command: "printf sample" };

test("backfill shares capacity with live calls", async () => {
  const response = deferred<string>();
  const service = new Summaries(
    { ...readConfig(), concurrency: 1 },
    () => response.promise,
  );
  service.start("live", "bash", args);
  let calls = 0;
  const pending = service.backfill("old", "bash", args, async () => {
    calls++;
    return "Printing text.";
  });
  assert.equal(calls, 0);
  response.resolve("Printing live text.");
  assert.equal(await pending, "generated");
  assert.equal(calls, 1);
  service.dispose();
});

test("backfill skips saved calls; force replaces them only on success", async () => {
  const saved: SavedSummary[] = [];
  const service = new Summaries(
    readConfig(),
    async () => "unused",
    (record) => saved.push(record),
  );
  const generate = async () => "Original summary.";
  assert.equal(
    await service.backfill("old", "bash", args, generate),
    "generated",
  );
  assert.equal(
    await service.backfill("old", "bash", args, generate),
    "skipped",
  );
  assert.equal(
    await service.backfill("old", "bash", args, async () => "", true),
    "failed",
  );
  assert.equal(
    service.view("old", "bash", args, () => {}).summary,
    "Original summary.",
  );
  assert.equal(saved.length, 1);
  assert.equal(
    await service.backfill(
      "old",
      "bash",
      args,
      async () => "Replacement.",
      true,
    ),
    "generated",
  );
  assert.equal(
    service.view("old", "bash", args, () => {}).summary,
    "Replacement.",
  );
  service.dispose();
});

test("pausing cancels queued backfill and preserves completed summaries", async () => {
  const config = readConfig();
  const service = new Summaries(config, async () => new Promise(() => {}));
  await service.backfill("saved", "bash", args, async () => "Printing text.");
  const pending = service.backfill(
    "pending",
    "bash",
    args,
    () => new Promise(() => {}),
  );
  config.enabled = false;
  service.cancelAll();
  assert.equal(await pending, "cancelled");
  assert.equal(
    service.view("saved", "bash", args, () => {}).summary,
    "Printing text.",
  );
  service.dispose();
});
