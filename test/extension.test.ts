import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

const dist = dirname(
  fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
);

test("Pi's extension loader loads the real TypeScript entry point", async () => {
  const { loadExtensions } = await import(
    pathToFileURL(join(dist, "core/extensions/loader.js")).href
  );
  const loaded = await loadExtensions([resolve("src/index.ts")], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].commands.has("tool-summaries"));
});

test("extension wraps only Bash, uses registry auth, and respects shell settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-summary-extension-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      shellCommandPrefix: "export FROM_PI_SETTINGS=preserved",
      toolSummaries: {
        model: "test-provider/test-cheap-model",
      },
    }),
  );
  const overrides = {
    PI_CODING_AGENT_DIR: agentDir,
  };
  const old = Object.fromEntries(
    Object.keys(overrides).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, overrides);
  const handlers = new Map<string, Function>();
  const registered = new Map<string, ToolDefinition<any, any, any>>();
  let requests = 0;
  const api = {
    on(name: string, handler: Function) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    registerTool(tool: ToolDefinition<any, any, any>) {
      registered.set(tool.name, tool);
    },
    getActiveTools() {
      return ["bash", "read", "write", "edit", "grep", "find", "ls"];
    },
    getAllTools() {
      return [
        { name: "bash", sourceInfo: { source: "builtin" } },
        { name: "read", sourceInfo: { source: "builtin" } },
        { name: "write", sourceInfo: { source: "builtin" } },
      ];
    },
  };
  const model = { id: "test-cheap-model" };
  const ctx = {
    cwd,
    mode: "tui",
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => "summary-test",
      getSessionFile: () => undefined,
    },
    getThinkingLevel: () => "off",
    ui: {
      notify() {
        assert.fail("No unsolicited notifications");
      },
    },
    modelRegistry: {
      find(provider: string, id: string) {
        assert.equal(provider, "test-provider");
        assert.equal(id, model.id);
        return model;
      },
      async complete(chosen: unknown, context: any, options: any) {
        requests++;
        assert.equal(chosen, model);
        assert.equal(context.messages.length, 1);
        assert.equal(context.tools, undefined);
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(options.cacheRetention, "none");
        assert.equal(Object.hasOwn(options, "reasoning"), false);
        assert.equal(options.reasoning, undefined);
        return {
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: "Print the configured shell prefix value.",
            },
          ],
        };
      },
    },
  };
  try {
    extension(api as unknown as ExtensionAPI);
    handlers.get("session_start")!({}, ctx);
    assert.deepEqual([...registered.keys()], ["bash"]);
    const args = { command: 'printf "%s" "$FROM_PI_SETTINGS"' };
    assert.equal(
      handlers.get("tool_execution_start")!(
        { toolName: "bash", toolCallId: "one", args },
        ctx,
      ),
      undefined,
    );
    const result = await registered
      .get("bash")!
      .execute("one", args, undefined, undefined, ctx as any);
    assert.deepEqual(result.content, [{ type: "text", text: "preserved" }]);
    await delay(5);
    assert.equal(requests, 1);
    handlers.get("session_shutdown")!({}, ctx);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default follows the current Pi model and captures it independently for each background call", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-summary-models-"));
  const keys = [
    "PI_CODING_AGENT_DIR",
    "PI_TOOL_SUMMARY_PROVIDER",
    "PI_TOOL_SUMMARY_MODEL",
    "PI_TOOL_SUMMARY_TOOLS",
  ];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.PI_CODING_AGENT_DIR = cwd;
  delete process.env.PI_TOOL_SUMMARY_PROVIDER;
  delete process.env.PI_TOOL_SUMMARY_MODEL;
  process.env.PI_TOOL_SUMMARY_TOOLS = "bash";
  const handlers = new Map<string, Function>();
  const chosen: unknown[] = [];
  let lookupCount = 0;
  const first = { provider: "provider-a", id: "first" };
  const second = { provider: "provider-b", id: "second" };
  const ctx = {
    cwd,
    mode: "tui",
    model: first as typeof first | undefined,
    isProjectTrusted: () => false,
    ui: {
      notify() {
        assert.fail("No unsolicited notifications");
      },
    },
    modelRegistry: {
      find(_provider: string, _id: string) {
        lookupCount++;
        return undefined;
      },
      async complete(model: unknown) {
        chosen.push(model);
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "I’ll print the sample text." }],
        };
      },
    },
  };
  const api = {
    on(name: string, handler: Function) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    registerTool() {},
    getActiveTools() {
      return ["bash"];
    },
    getAllTools() {
      return [{ name: "bash", sourceInfo: { source: "builtin" } }];
    },
  };
  try {
    extension(api as unknown as ExtensionAPI);
    handlers.get("session_start")!({}, ctx);
    handlers.get("tool_execution_start")!(
      {
        toolName: "bash",
        toolCallId: "parent/1",
        parentToolCallId: "parent",
        args: { command: "printf nested" },
      },
      ctx,
    );
    await delay(5);
    assert.equal(
      chosen.length,
      0,
      "Hidden nested calls must not generate summaries",
    );
    handlers.get("tool_execution_start")!(
      { toolName: "bash", toolCallId: "a", args: { command: "printf first" } },
      ctx,
    );
    ctx.model = second;
    handlers.get("tool_execution_start")!(
      { toolName: "bash", toolCallId: "b", args: { command: "printf second" } },
      ctx,
    );
    await delay(10);
    assert.deepEqual(chosen, [first, second]);
    assert.equal(lookupCount, 0);
    ctx.model = undefined;
    handlers.get("tool_execution_start")!(
      {
        toolName: "bash",
        toolCallId: "c",
        args: { command: "printf missing" },
      },
      ctx,
    );
    await delay(5);
    assert.equal(chosen.length, 2);
    // An unavailable explicit override must never silently spend on the main model.
    ctx.model = first;
    await writeFile(
      join(cwd, "settings.json"),
      JSON.stringify({ toolSummaries: { model: "unavailable/model" } }),
    );
    handlers.get("session_start")!({}, ctx);
    handlers.get("tool_execution_start")!(
      {
        toolName: "bash",
        toolCallId: "d",
        args: { command: "printf override" },
      },
      ctx,
    );
    await delay(5);
    assert.equal(chosen.length, 2);
    assert.equal(lookupCount, 1);
    handlers.get("session_shutdown")!({}, ctx);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("inactive or replaced Bash and invalid settings fail open silently", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-summary-fallback-"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  try {
    for (const scenario of ["inactive", "replacement", "invalid"]) {
      await writeFile(
        join(cwd, "settings.json"),
        JSON.stringify({
          toolSummaries: scenario === "invalid" ? { model: 42 } : {},
        }),
      );
      const handlers = new Map<string, Function>();
      let statusCommand: Function | undefined;
      const notifications: string[] = [];
      const api = {
        on(name: string, handler: Function) {
          handlers.set(name, handler);
        },
        registerCommand(_name: string, definition: { handler: Function }) {
          statusCommand = definition.handler;
        },
        registerTool() {
          assert.fail("Must not replace the original tool");
        },
        getActiveTools() {
          return scenario === "inactive" ? ["read"] : ["bash"];
        },
        getAllTools() {
          return [
            {
              name: "bash",
              sourceInfo: {
                source: scenario === "replacement" ? "extension" : "builtin",
              },
            },
          ];
        },
      };
      const ctx = {
        cwd,
        mode: "tui",
        isProjectTrusted: () => false,
        ui: {
          notify(text: string) {
            notifications.push(text);
          },
        },
        modelRegistry: {
          find() {
            assert.fail("No provider lookup expected");
          },
        },
      };
      extension(api as unknown as ExtensionAPI);
      handlers.get("session_start")!({}, ctx);
      handlers.get("tool_execution_start")!(
        {
          toolName: "bash",
          toolCallId: scenario,
          args: { command: "printf unchanged" },
        },
        ctx,
      );
      assert.deepEqual(notifications, []);
      await statusCommand!("", ctx);
      assert.equal(notifications.length, 1);
      assert.match(
        notifications[0],
        scenario === "inactive"
          ? /inactive/
          : scenario === "replacement"
            ? /replacement/
            : /toolSummaries.model/,
      );
      handlers.get("session_shutdown")!({}, ctx);
    }
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    await rm(cwd, { recursive: true, force: true });
  }
});
