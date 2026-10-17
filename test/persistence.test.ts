import assert from "node:assert/strict";
import { test } from "node:test";
import { Summaries, type SavedSummary } from "../src/summaries.js";
import { readConfig } from "../src/config.js";

const args = { command: "printf sample" };

test("saved records restore summaries for the same arguments", async () => {
  const records: SavedSummary[] = [];
  const first = new Summaries(
    readConfig(),
    async () => "unused",
    (record) => records.push(record),
  );
  await first.backfill("call", "bash", args, async () => "Printing text.");
  const resumed = new Summaries(readConfig(), async () => "unused");
  resumed.restore(records[0]);
  assert.equal(
    resumed.view("call", "bash", args, () => {}).summary,
    "Printing text.",
  );
  assert.equal(
    resumed.view("call", "bash", { command: "other" }, () => {}).summary,
    undefined,
  );
  for (const invalid of [
    null,
    {},
    { ...records[0], version: 99 },
    { ...records[0], id: "bad", summary: "" },
  ])
    resumed.restore(invalid);
  assert.equal(resumed.view("bad", "bash", args, () => {}).summary, undefined);
  first.dispose();
  resumed.dispose();
});

test("a persistence failure leaves the summary visible", async () => {
  const service = new Summaries(
    readConfig(),
    async () => "unused",
    () => {
      throw new Error("private storage error");
    },
  );
  await service.backfill("call", "bash", args, async () => "Printing text.");
  assert.equal(
    service.view("call", "bash", args, () => {}).summary,
    "Printing text.",
  );
  assert.equal(
    service.lastPersistenceIssue,
    "Could not persist summary in the session",
  );
  service.dispose();
});
