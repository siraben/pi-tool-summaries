import assert from "node:assert/strict";
import { test } from "node:test";
import { Summaries, type SavedSummary } from "../src/summaries.js";
import { readConfig } from "../src/config.js";

const args = { command: "printf sample" };
const config = { ...readConfig(), concurrency: 1, timeoutMs: 1000 };

test("backfill waits for live capacity, persists, refreshes, and skips restored summaries", async () => {
  let finish!: (text: string) => void;
  const saved: SavedSummary[] = [];
  const service = new Summaries(
    config,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    (r) => saved.push(r),
  );
  service.start("live", "bash", args);
  await Promise.resolve();
  let requests = 0;
  let refreshed = 0;
  service.view("old", "bash", args, () => refreshed++);
  const generate = async () => {
    requests++;
    return "Printing sample text.";
  };
  const pending = service.backfill("old", "bash", args, generate);
  assert.equal(requests, 0);
  finish("Printing live text.");
  assert.equal(await pending, "generated");
  assert.equal(refreshed, 1);
  assert.equal(saved.length, 2);
  assert.equal(
    await service.backfill("old", "bash", args, generate),
    "skipped",
  );
  const resumed = new Summaries(config, generate);
  for (const record of saved) resumed.restore(record);
  assert.equal(
    await resumed.backfill("old", "bash", args, generate),
    "skipped",
  );
  assert.equal(requests, 1);
  service.dispose();
  resumed.dispose();
});

test("backfill retries failures and respects input limits", async () => {
  const service = new Summaries(config, async () => "");
  assert.equal(
    await service.backfill("old", "bash", args, async () => ""),
    "failed",
  );
  assert.equal(
    await service.backfill("old", "bash", args, async () => "Printing text."),
    "generated",
  );
  assert.equal(
    await service.backfill(
      "large",
      "bash",
      { command: "x".repeat(config.maxInputChars) },
      async () => {
        assert.fail("Oversized input");
      },
    ),
    "failed",
  );
  service.dispose();
});

test("disposing cancels a waiting backfill and prevents late persistence", async () => {
  const saved: SavedSummary[] = [];
  const service = new Summaries(
    config,
    async () => new Promise(() => {}),
    (r) => saved.push(r),
  );
  service.start("live", "bash", args);
  const pending = service.backfill("old", "bash", args, async () => {
    assert.fail("Cancelled queue");
  });
  service.dispose();
  assert.equal(await pending, "cancelled");
  assert.deepEqual(saved, []);
});
