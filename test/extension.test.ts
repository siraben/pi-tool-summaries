import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, message } from "./helpers.js";

// Await backfill for the same call to settle background work; no clock assumptions.
test("live calls use Pi's current model and report its usage", async (t) => {
  const f = await fixture(t);
  await f.summarize("first");
  assert.equal(f.calls[0].model.id, "current");
  assert.equal(f.calls[0].input.tool, "bash");
  assert.equal(f.calls[0].input.arguments.command, "printf sample");
  f.ctx.model = { provider: "other", id: "selected" };
  await f.summarize("second");
  assert.equal(f.calls[1].model.id, "selected");
  await f.command();
  assert.match(f.notices.at(-1)!, /2 generation attempts/);
  assert.match(f.notices.at(-1)!, /input 20, output 10/);
});

test("a dedicated model uses Pi lookup and never falls back when missing", async (t) => {
  const f = await fixture(t, { model: "dedicated/small" });
  f.start("missing", { command: "printf sample" });
  assert.equal(f.calls.length, 0);
  const dedicated = { provider: "dedicated", id: "small" };
  f.ctx.modelRegistry.find = (provider, id) =>
    provider === dedicated.provider && id === dedicated.id
      ? dedicated
      : undefined;
  await f.summarize("available");
  assert.equal(f.calls[0].model, dedicated);
});

test("on/off controls override the enabled setting until reload", async (t) => {
  const f = await fixture(t, { enabled: false });
  f.start("disabled", { command: "printf sample" });
  assert.equal(f.calls.length, 0);
  await f.command("on");
  await f.summarize("enabled");
  assert.equal(f.calls.length, 1);
  await f.command("off");
  f.start("paused", { command: "printf sample" });
  assert.equal(f.calls.length, 1);
  f.restart();
  await f.command();
  assert.match(f.notices.at(-1)!, /Requests: paused/);
});

test("backfill respects the message count and regenerates only with force", async (t) => {
  const f = await fixture(t);
  f.state.history = [message("old"), message("recent")];
  await f.command("backfill 1");
  assert.equal(f.calls[0].input.arguments.command, "printf recent");
  await f.command("backfill 1");
  assert.equal(f.calls.length, 1);
  await f.command("backfill 1 --force");
  assert.equal(f.calls.length, 2);
  await f.command("backfill");
  assert.equal(f.calls.length, 3);
});

test("saved summaries restore on session start without another request", async (t) => {
  const f = await fixture(t);
  await f.summarize("saved");
  f.state.entries = [
    {
      type: "custom",
      customType: "tool-summaries:summary",
      data: f.records[0],
    },
  ];
  f.restart();
  await f.command("backfill");
  assert.equal(f.calls.length, 1);
});

test("short, nested and non-interactive calls do not request summaries", async (t) => {
  const f = await fixture(t, { minCommandChars: 150 });
  f.start("short", { command: "pwd" });
  f.start(
    "nested",
    { command: "x".repeat(150) },
    { parentToolCallId: "parent" },
  );
  assert.equal(f.calls.length, 0);
  f.ctx.mode = "rpc";
  f.restart();
  await f.summarize("rpc", { command: "x".repeat(150) });
  assert.equal(f.calls.length, 0);
});
