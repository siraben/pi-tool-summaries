import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

async function fixture(settings: object = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-summary-controls-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  await writeFile(
    join(cwd, "settings.json"),
    JSON.stringify({ toolSummaries: { minCommandChars: 0, ...settings } }),
  );
  const events = new Map<string, Function>();
  let command!: Function;
  const notices: string[] = [];
  const records: any[] = [];
  const calls: any[] = [];
  let authenticated = true;
  let respond: (input: any) => Promise<any> = async () => ({
    stopReason: "stop",
    content: [{ type: "text", text: "Reading files." }],
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
      cost: { total: 0.001 },
    },
  });
  const model = {
    provider: "subscription-or-custom",
    id: "selected",
    api: "openai-completions",
  };
  let branch: any[] = [];
  const ctx = {
    cwd,
    mode: "tui",
    isProjectTrusted: () => false,
    model,
    ui: { notify: (text: string) => notices.push(text) },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => branch,
      getSessionFile: () => "session.jsonl",
    },
    modelRegistry: {
      find() {
        return undefined;
      },
      hasConfiguredAuth() {
        assert.fail(
          "Do not reject ambient/keyless providers from a static hint",
        );
      },
      async getApiKeyAndHeaders(chosen: unknown) {
        assert.equal(chosen, model);
        return authenticated
          ? { ok: true, headers: { "x-refreshed-oauth": "private" } }
          : { ok: false, error: "Bearer private" };
      },
      async complete(chosen: unknown, context: any) {
        assert.equal(chosen, model);
        const input = JSON.parse(context.messages[0].content[0].text);
        calls.push(input);
        return respond(input);
      },
    },
  };
  extension({
    on: (name: string, handler: Function) => events.set(name, handler),
    registerCommand: (_: string, definition: { handler: Function }) => {
      command = definition.handler;
    },
    registerTool() {},
    getActiveTools: () => ["bash"],
    getAllTools: () => [{ name: "bash", sourceInfo: { source: "builtin" } }],
    appendEntry: (_: string, record: unknown) => records.push(record),
  } as unknown as ExtensionAPI);
  events.get("session_start")!({}, ctx);
  return {
    calls,
    records,
    notices,
    authenticated: (value: boolean) => {
      authenticated = value;
    },
    respond: (value: typeof respond) => {
      respond = value;
    },
    branch: (value: any[]) => {
      branch = value;
    },
    start: (id: string, text = "printf public") =>
      events.get("tool_execution_start")!(
        { toolCallId: id, toolName: "bash", args: { command: text } },
        ctx,
      ),
    command: (text: string) => command(text, ctx),
    restart: () => events.get("session_start")!({}, ctx),
    mode: (value: string) => {
      ctx.mode = value;
    },
    async close() {
      events.get("session_shutdown")!({}, ctx);
      await delay(5);
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(cwd, { recursive: true, force: true });
    },
  };
}
const call = (id: string) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id,
        name: "bash",
        arguments: { command: `printf ${id}` },
      },
    ],
  },
});

test("non-interactive modes never issue display-summary requests", async () => {
  const f = await fixture();
  try {
    for (const mode of ["print", "json", "rpc", "sdk"]) {
      f.mode(mode);
      f.restart();
      f.start(mode);
      await delay(5);
      await f.command("backfill");
      assert.equal(f.calls.length, 0);
      assert.match(f.notices.at(-1)!, /Disabled outside interactive mode/);
    }
  } finally {
    await f.close();
  }
});

test("persistent disable can be overridden for the runtime only", async () => {
  const f = await fixture({ enabled: false });
  try {
    f.start("disabled");
    await delay(5);
    await f.command("backfill");
    assert.match(f.notices.at(-1)!, /paused/);
    assert.equal(f.calls.length, 0);
    await f.command("on");
    f.start("enabled");
    await delay(5);
    assert.equal(f.calls.length, 1);
    f.restart();
    f.start("disabled-again");
    await delay(5);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("missing auth is diagnosed once, no generation is sent, retry after login recovers", async () => {
  const f = await fixture();
  try {
    f.authenticated(false);
    f.start("a");
    await delay(5);
    f.start("b");
    await delay(5);
    assert.equal(f.calls.length, 0);
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0], /authentication unavailable/);
    assert.doesNotMatch(f.notices[0], /Bearer|private/);
    await f.command("");
    assert.match(f.notices.at(-1)!, /Readiness: .*cooldown/);
    f.authenticated(true);
    await f.command("retry");
    f.start("c");
    await delay(5);
    assert.equal(f.calls.length, 1);
    assert.equal(f.records.length, 1);
    await f.command("");
    assert.match(f.notices.at(-1)!, /credentials resolved/);
  } finally {
    await f.close();
  }
});

test("session pause, literal exclusions, and shared live/backfill cap cannot be bypassed by retry", async () => {
  const f = await fixture({ maxRequests: 2, exclude: ["private"] });
  try {
    f.start("excluded", "printf private");
    await delay(5);
    await f.command("off");
    f.start("paused");
    await delay(5);
    assert.equal(f.calls.length, 0);
    await f.command("toggle");
    f.start("live");
    await delay(5);
    f.branch([call("historical"), call("over-cap")]);
    await f.command("backfill");
    assert.equal(f.calls.length, 2);
    assert.equal(f.records.length, 2);
    assert.match(f.notices.at(-1)!, /Stopped: .*cap reached/);
    await f.command("retry");
    f.start("after-retry");
    await delay(5);
    assert.equal(f.calls.length, 2);
    await f.command("");
    const status = f.notices.at(-1)!;
    assert.match(status, /2\/2 generation attempts/);
    assert.match(status, /input 20, output 10, cache read 4/);
    assert.match(status, /\$0\.002000 USD/);
    f.restart();
    f.start("new-runtime");
    await delay(5);
    assert.equal(f.calls.length, 3);
  } finally {
    await f.close();
  }
});

test("cancel aborts backfill only, suppresses late summaries, and releases it for restart", async () => {
  const f = await fixture();
  let finish!: () => void;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  try {
    f.branch([call("historical"), call("never-started")]);
    f.respond(async (input) => {
      if (input.arguments.command === "printf historical") {
        began();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
      return {
        stopReason: "stop",
        content: [{ type: "text", text: "Reading files." }],
      };
    });
    const backfill = f.command("backfill");
    await started;
    f.start("live", "printf still-live");
    await delay(5);
    await f.command("cancel");
    await backfill;
    finish();
    await delay(5);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(
      f.records.map((record) => record.id),
      ["live"],
    );
    assert.ok(
      f.notices.some((text) => text.includes("live summaries are unaffected")),
    );
    f.branch([call("next")]);
    await f.command("backfill");
    assert.equal(f.records.length, 2);
  } finally {
    finish?.();
    await f.close();
  }
});

test("explicit missing model never falls back to an authenticated current model", async () => {
  const f = await fixture({ model: "missing/provider-model" });
  try {
    f.start("a");
    f.start("b");
    await delay(5);
    assert.equal(f.calls.length, 0);
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0], /model unavailable/);
    await f.command("backfill");
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});
