import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import * as host from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { readConfig } from "../src/config.js";
import { Summaries } from "../src/summaries.js";
import { withSummary } from "../src/renderer.js";

test("PowerShell uses its native renderer, summarizes/backfills command arguments, and obeys privacy controls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-summary-ps-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  await writeFile(
    join(cwd, "settings.json"),
    JSON.stringify({
      toolSummaries: { minCommandChars: 0, exclude: ["DO_NOT_SEND"] },
    }),
  );
  const events = new Map<string, Function>();
  let command!: Function, resolver!: Function;
  const requests: any[] = [],
    records: any[] = [],
    notices: string[] = [];
  let source = "builtin";
  let activeTools = ["read"];
  const args = {
    command:
      "$items = Get-ChildItem -LiteralPath .; $items | Where-Object { $_.Extension -eq '.ts' } | Select-Object Name",
  };
  const model = { provider: "test", id: "powershell-summary" };
  const ctx = {
    cwd,
    mode: "tui",
    model,
    isProjectTrusted: () => false,
    ui: { notify: (text: string) => notices.push(text) },
    sessionManager: {
      getEntries: () => [],
      getSessionFile: () => "session.jsonl",
      getBranch: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "old",
                name: "powershell",
                arguments: args,
              },
            ],
          },
        },
      ],
    },
    modelRegistry: {
      async complete(chosen: unknown, context: any) {
        assert.equal(chosen, model);
        requests.push(JSON.parse(context.messages[0].content[0].text));
        return {
          stopReason: "stop",
          content: [
            {
              type: "text",
              text: "Listing TypeScript file names in the current directory.",
            },
          ],
        };
      },
    },
  };
  try {
    extension({
      on: (name: string, handler: Function) => events.set(name, handler),
      registerCommand: (_: string, definition: any) => {
        command = definition.handler;
      },
      registerToolRenderer: (value: Function) => {
        resolver = value;
      },
      registerTool() {
        assert.fail("Never recreate or replace native PowerShell execution");
      },
      getActiveTools: () => activeTools,
      getAllTools: () => [{ name: "powershell", sourceInfo: { source } }],
      appendEntry: (_: string, record: unknown) => records.push(record),
    } as unknown as host.ExtensionAPI);
    events.get("session_start")!({}, ctx);
    activeTools = ["read", "powershell"];
    const native = { render: () => [`PS> ${args.command}`], invalidate() {} };
    const original = {
      renderCall: () => native,
      renderResult() {},
      renderShell: "self",
    };
    const wrapped = resolver("powershell", () => original);
    assert.notEqual(wrapped, original);
    assert.equal(wrapped.renderResult, original.renderResult);
    assert.equal(wrapped.renderShell, original.renderShell);
    let invalidations = 0;
    const context = {
      toolCallId: "live",
      state: {},
      expanded: false,
      invalidate: () => invalidations++,
    };
    const theme = {
      bold: (text: string) => text,
      fg: (_: string, text: string) => text,
    };
    const render = () =>
      stripVTControlCharacters(
        wrapped.renderCall(args, theme, context).render(100).join("\n"),
      );
    assert.match(render(), /PS>/);
    events.get("tool_execution_start")!(
      { toolName: "powershell", toolCallId: "live", args },
      ctx,
    );
    await delay(5);
    assert.deepEqual(requests, [{ tool: "powershell", arguments: args }]);
    assert.ok(invalidations > 0);
    assert.match(render(), /Listing TypeScript file names/);
    context.expanded = true;
    assert.equal(render(), `PS> ${args.command}`);
    await command("backfill", ctx);
    assert.equal(requests.length, 2);
    assert.equal(records[1].id, "old");
    events.get("tool_execution_start")!(
      {
        toolName: "powershell",
        toolCallId: "private",
        args: { command: "Write-Output DO_NOT_SEND" },
      },
      ctx,
    );
    source = "extension";
    assert.equal(
      resolver("powershell", () => original),
      original,
    );
    events.get("tool_execution_start")!(
      { toolName: "powershell", toolCallId: "replacement", args },
      ctx,
    );
    await delay(5);
    assert.equal(requests.length, 2);
    source = "builtin";
    await command("off", ctx);
    events.get("tool_execution_start")!(
      { toolName: "powershell", toolCallId: "paused", args },
      ctx,
    );
    await delay(5);
    assert.equal(requests.length, 2);
    await command("", ctx);
    assert.match(notices.at(-1)!, /PowerShell and codemode summaries enabled/);
    assert.match(notices.at(-1)!, /Requests: paused/);
  } finally {
    events.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("replacement PowerShell and legacy Pi without renderer registration remain native", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-summary-ps-native-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  try {
    for (const replacement of [true, false]) {
      const events = new Map<string, Function>();
      let resolver: Function | undefined, command!: Function;
      const notices: string[] = [];
      extension({
        on: (name: string, handler: Function) => events.set(name, handler),
        registerCommand: (_: string, definition: any) => {
          command = definition.handler;
        },
        ...(replacement
          ? {
              registerToolRenderer: (value: Function) => {
                resolver = value;
              },
            }
          : {}),
        registerTool() {
          assert.fail("Must preserve native tool");
        },
        getActiveTools: () => ["powershell"],
        getAllTools: () => [
          {
            name: "powershell",
            sourceInfo: { source: replacement ? "extension" : "builtin" },
          },
        ],
      } as unknown as host.ExtensionAPI);
      const ctx = {
        cwd,
        mode: "tui",
        isProjectTrusted: () => false,
        ui: { notify: (text: string) => notices.push(text) },
        sessionManager: {
          getEntries: () => [],
          getSessionFile: () => undefined,
        },
        modelRegistry: {
          complete() {
            assert.fail("No request");
          },
        },
      };
      events.get("session_start")!({}, ctx);
      const original = { renderCall() {} };
      if (resolver)
        assert.equal(
          resolver("powershell", () => original),
          original,
        );
      events.get("tool_execution_start")!(
        {
          toolName: "powershell",
          toolCallId: "a",
          args: { command: "Write-Output 'x'".repeat(20) },
        },
        ctx,
      );
      await command("", ctx);
      assert.match(
        notices.at(-1)!,
        replacement
          ? /replacement PowerShell/
          : /PowerShell summaries require Pi 1.0.1/,
      );
      events.get("session_shutdown")!({}, ctx);
    }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test(
  "native PowerShell execution preserves cwd, file writes, output, exit codes and cancellation on Windows",
  { skip: process.platform !== "win32", timeout: 30000 },
  async () => {
    const create = (host as any).createPowerShellToolDefinition;
    assert.equal(
      typeof create,
      "function",
      "Windows coverage requires Pi's PowerShell factory",
    );
    const cwd = await mkdtemp(join(tmpdir(), "pi-summary-ps-exec-"));
    const service = new Summaries(readConfig(), async () => "unused");
    const original = create(cwd, { exposeSessionEnvironment: false });
    const wrapped = withSummary(original, service);
    assert.equal(wrapped.execute, original.execute);
    assert.equal(wrapped.parameters, original.parameters);
    assert.equal(wrapped.renderResult, original.renderResult);
    try {
      const result = await wrapped.execute(
        "exec",
        {
          command:
            "Set-Content -LiteralPath marker.txt -Value 'kept'; Get-Content -Raw -LiteralPath marker.txt",
        },
        undefined,
        undefined,
        {} as any,
      );
      assert.equal(
        (await readFile(join(cwd, "marker.txt"), "utf8")).trim(),
        "kept",
      );
      assert.match(JSON.stringify(result.content), /kept/);
      const failure = await wrapped.execute(
        "fail",
        { command: "exit 7" },
        undefined,
        undefined,
        {} as any,
      );
      assert.equal((failure as any).isError, true);
      assert.equal((failure as any).structuredContent.exit_code, 7);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        wrapped.execute(
          "abort",
          { command: "Start-Sleep -Seconds 10" },
          controller.signal,
          undefined,
          {} as any,
        ),
        /abort/i,
      );
    } finally {
      service.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
