import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

export const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: {
    input: 0.001,
    output: 0.001,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.002,
  },
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const message = (
  id: string,
  name = "bash",
  args = { command: `printf ${id}` } as object,
) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
  },
});

export async function fixture(
  t: TestContext,
  settings: object = {},
  options: {
    tool?: string;
    renderers?: boolean;
    source?: string;
    mode?: string;
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-summaries-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  await writeFile(
    join(cwd, "settings.json"),
    JSON.stringify({ toolSummaries: { minCommandChars: 0, ...settings } }),
  );
  const tool = options.tool ?? "bash";
  const handlers = new Map<string, Function>();
  const notices: string[] = [],
    records: any[] = [],
    calls: any[] = [],
    registered: any[] = [];
  const state = {
    history: [] as any[],
    entries: [] as any[],
    source: options.source ?? "builtin",
  };
  let command!: Function, renderer!: Function;
  const ctx = {
    cwd,
    mode: options.mode ?? "tui",
    isProjectTrusted: () => false,
    model: { provider: "test", id: "current" } as any,
    ui: { notify: (text: string) => notices.push(text) },
    sessionManager: {
      getEntries: () => state.entries,
      getBranch: () => state.history,
      getSessionFile: () => "session.jsonl",
    },
    modelRegistry: {
      find: (_provider: string, _id: string): any => undefined,
      async complete(model: any, context: any) {
        calls.push({
          model,
          input: JSON.parse(context.messages[0].content[0].text),
        });
        return {
          stopReason: "stop",
          content: [{ type: "text", text: "Reading files." }],
          usage,
        };
      },
    },
  };
  extension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (_: string, definition: any) => {
      command = definition.handler;
    },
    ...(options.renderers === false
      ? {}
      : {
          registerToolRenderer: (value: Function) => {
            renderer = value;
          },
        }),
    registerTool: (definition: any) => registered.push(definition),
    getActiveTools: () => [tool],
    getAllTools: () => [{ name: tool, sourceInfo: { source: state.source } }],
    appendEntry: (_: string, record: any) => records.push(record),
  } as unknown as ExtensionAPI);
  const restart = () => handlers.get("session_start")!({}, ctx);
  const start = (id: string, args: object, extra: object = {}) =>
    handlers.get("tool_execution_start")!(
      { toolName: tool, toolCallId: id, args, ...extra },
      ctx,
    );
  t.after(async () => {
    handlers.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  });
  restart();
  return {
    ctx,
    state,
    notices,
    records,
    calls,
    registered,
    restart,
    start,
    command: (args = "") => command(args, ctx),
    renderer: (original: any) => renderer(tool, () => original),
    async summarize(id: string, args: object = { command: "printf sample" }) {
      state.history = [message(id, tool, args)];
      start(id, args);
      await command("backfill", ctx);
    },
  };
}
