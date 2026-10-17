import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./helpers.js";

for (const tool of ["bash", "powershell", "codemode"]) {
  test(`${tool}: collapsed summaries leave expanded calls and results native`, async (t) => {
    const f = await fixture(t, {}, { tool });
    const args =
      tool === "codemode"
        ? { code: "text('hello');" }
        : { command: "echo hello" };
    const native = { render: () => ["original call"], invalidate() {} };
    const result = () => native;
    const wrapped = f.renderer({
      renderCall: () => native,
      renderResult: result,
    });
    const context = {
      toolCallId: "call",
      state: {},
      expanded: false,
      invalidate() {},
    };
    const theme = {
      fg: (_: string, text: string) => text,
      bold: (text: string) => text,
    };
    assert.equal(wrapped.renderCall(args, theme, context), native);
    await f.summarize("call", args);
    assert.match(
      wrapped.renderCall(args, theme, context).render(80).join("\n"),
      /Reading files/,
    );
    context.expanded = true;
    assert.equal(wrapped.renderCall(args, theme, context), native);
    assert.equal(wrapped.renderResult, result);
    assert.equal(f.registered.length, 0);
  });
}

for (const tool of ["bash", "powershell"]) {
  test(`${tool}: replacement tools remain untouched`, async (t) => {
    const f = await fixture(t, {}, { tool, source: "extension" });
    const original = { renderCall() {} };
    assert.equal(f.renderer(original), original);
    f.start("replacement", { command: "printf sample" });
    assert.equal(f.calls.length, 0);
  });
}

test("legacy Pi uses the Bash compatibility wrapper", async (t) => {
  const f = await fixture(t, {}, { renderers: false });
  assert.equal(f.registered[0].name, "bash");
  await f.summarize("legacy");
  assert.equal(f.records[0].summary, "Reading files.");
});

test("PowerShell stays native when Pi has no renderer registration", async (t) => {
  const f = await fixture(t, {}, { tool: "powershell", renderers: false });
  await f.summarize("legacy");
  assert.equal(f.calls.length, 0);
  await f.command();
  assert.match(f.notices.at(-1)!, /PowerShell summaries require Pi 1.0.1/);
});
