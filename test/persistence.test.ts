import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Summaries, fingerprint, type SavedSummary } from "../src/summaries.js";
import { readConfig } from "../src/config.js";

const args = { command: "printf sample" };
const summary = "Printing the sample text.";
const config = { ...readConfig(), timeoutMs: 1000 };
const key = fingerprint("bash", args);

test("invalid, failed, cancelled, and disposed requests never persist", async () => {
  for (const outcome of ["empty", "large", "error", "cancel", "dispose"]) {
    let finish!: (text: string) => void;
    const saved: SavedSummary[] = [];
    const generate = () =>
      outcome === "error"
        ? Promise.reject(new Error("secret"))
        : outcome === "empty"
          ? Promise.resolve("   ")
          : outcome === "large"
            ? Promise.resolve("x".repeat(2001))
            : new Promise<string>((resolve) => {
                finish = resolve;
              });
    const service = new Summaries(config, generate, (r) => saved.push(r));
    const parent = new AbortController();
    service.start(outcome, "bash", args, parent.signal, generate);
    await delay(5);
    if (outcome === "cancel") parent.abort();
    if (outcome === "dispose") service.dispose();
    finish?.(summary);
    await delay(5);
    assert.deepEqual(saved, []);
    service.dispose();
  }
});

test("session persistence failures preserve summaries; malformed records are ignored", async () => {
  const service = new Summaries(
    config,
    async () => summary,
    () => {
      throw new Error("secret");
    },
  );
  service.start("call", "bash", args);
  await delay(5);
  assert.equal(service.view("call", "bash", args, () => {}).summary, summary);
  assert.equal(
    service.lastPersistenceIssue,
    "Could not persist summary in the session",
  );
  for (const data of [
    null,
    {},
    { version: 2 },
    { version: 1, id: "bad", fingerprint: key, summary: "" },
  ])
    service.restore(data);
  assert.equal(service.view("bad", "bash", args, () => {}).summary, undefined);
  service.dispose();
});

test("restores every persisted summary in sessions with more than 256 calls", () => {
  const service = new Summaries(config, async () => "unused");
  for (let i = 0; i < 300; i++)
    service.restore({
      version: 1,
      id: `call-${i}`,
      fingerprint: key,
      summary: `Summary ${i}.`,
    });
  for (let i = 0; i < 300; i++)
    assert.equal(
      service.view(`call-${i}`, "bash", args, () => {}).summary,
      `Summary ${i}.`,
    );
  service.dispose();
});

for (const persistent of [true, false]) {
  test(`session summaries ${persistent ? "survive reopening JSONL" : "stay in memory without files"}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "pi-summary-session-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const manager = persistent
      ? SessionManager.create(root, root)
      : SessionManager.inMemory(root);
    manager.appendMessage({
      role: "user",
      content: "Run the sample",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Running" }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    let requests = 0;
    const generate = async () => {
      requests++;
      return summary;
    };
    const first = new Summaries(config, generate, (record) =>
      manager.appendCustomEntry("tool-summaries:summary", record),
    );
    first.start("call", "bash", args);
    await delay(10);
    first.dispose();
    const source = persistent
      ? SessionManager.open(manager.getSessionFile()!)
      : manager;
    const resumed = new Summaries(config, generate);
    t.after(() => resumed.dispose());
    for (const entry of source.getEntries()) {
      if (
        entry.type === "custom" &&
        entry.customType === "tool-summaries:summary"
      )
        resumed.restore(entry.data);
    }
    // Rendering old transcript rows must not evict the saved summary before reaching it.
    for (let i = 0; i < 300; i++)
      resumed.view(`old-${i}`, "bash", args, () => {});
    assert.equal(resumed.view("call", "bash", args, () => {}).summary, summary);
    assert.equal(
      resumed.view("call", "bash", { command: "different" }, () => {}).summary,
      undefined,
    );
    resumed.start("call", "bash", args);
    assert.equal(requests, 1);
    if (persistent)
      assert.ok(readdirSync(root).every((name) => name.endsWith(".jsonl")));
    else {
      assert.equal(manager.getSessionFile(), undefined);
      assert.deepEqual(readdirSync(root), []);
    }
  });
}
