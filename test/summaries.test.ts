import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config.js";
import {
  Summaries,
  cleanSummary,
  type SavedSummary,
} from "../src/summaries.js";
import { deferred } from "./helpers.js";

const args = { command: "printf sample" };

test("live requests are deduplicated and rendering does not start requests", async () => {
  const response = deferred<string>();
  let calls = 0;
  const service = new Summaries(readConfig(), () => {
    calls++;
    return response.promise;
  });
  service.view("call", "bash", args, () => {});
  assert.equal(calls, 0);
  service.start("call", "bash", args);
  const pending = service.backfill("call", "bash", args, async () => {
    throw new Error("duplicate request");
  });
  response.resolve("Printing sample text.");
  assert.equal(await pending, "skipped");
  assert.equal(calls, 1);
  assert.equal(
    service.view("call", "bash", args, () => {}).summary,
    "Printing sample text.",
  );
  assert.equal(
    service.view("call", "bash", { command: "different" }, () => {}).summary,
    undefined,
  );
  service.dispose();
});

test("invalid responses and oversized inputs leave the original view", async () => {
  const saved: SavedSummary[] = [];
  const service = new Summaries(
    readConfig(),
    async () => "",
    (record) => saved.push(record),
  );
  for (const text of ["", "x".repeat(2001)]) {
    assert.equal(
      await service.backfill(
        text.length.toString(),
        "bash",
        args,
        async () => text,
      ),
      "failed",
    );
  }
  let requested = false;
  assert.equal(
    await service.backfill(
      "large",
      "bash",
      { command: "x".repeat(24000) },
      async () => {
        requested = true;
        return "Printing text.";
      },
    ),
    "failed",
  );
  assert.equal(requested, false);
  assert.equal(saved.length, 0);
  service.dispose();
});

test("cancellation prevents late persistence without relying on provider cooperation", async () => {
  const response = deferred<string>();
  const saved: SavedSummary[] = [];
  const service = new Summaries(
    readConfig(),
    async () => "unused",
    (record) => saved.push(record),
  );
  const controller = new AbortController();
  const started = deferred<void>();
  const settled = deferred<void>();
  service.view("cancelled", "bash", args, () => settled.resolve(undefined));
  service.start("cancelled", "bash", args, controller.signal, () => {
    started.resolve(undefined);
    return response.promise;
  });
  await started.promise;
  controller.abort();
  await settled.promise;
  response.resolve("Late response.");
  await service.backfill("next", "bash", args, async () => "Printing text.");
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.id, "next");
  service.dispose();
});

test("display text removes terminal escapes and direction controls", () => {
  assert.equal(
    cleanSummary("\u001b[31mReading\u001b[0m\nfiles.\u202e"),
    "Reading files.",
  );
});
