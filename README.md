# Pi Tool Summaries

Plain-language summaries of tool calls.

Collapsed Bash calls show what the agent intends to do: “I’ll search the TypeScript files for `oldApi` and print the matches.” Press **Ctrl+O** to see the entire original command, including multiline scripts and heredocs.

Summaries run in the background using **your currently selected Pi model**. Tool execution and native results stay unchanged. While a summary is pending or unavailable, the original call remains visible.

## Install

Requires **Pi 0.84.4+** and Node 22.19+. Tested with Pi 0.84.4, 0.99.2, and 1.0.0.

```sh
pi install git:github.com/siraben/pi-tool-summaries
```

Restart Pi or run `/reload`. Use `/tool-summaries` to inspect the effective model and status.

## Configuration

Add `toolSummaries` to `~/.pi/agent/settings.json` (or your custom Pi agent directory). Trusted project `.pi/settings.json` values override global settings. Run `/reload` after editing.

```json
{
  "toolSummaries": {
    "model": "openrouter/openai/gpt-6-luna",
    "reasoning": "low"
  }
}
```

Omit `model` to follow the current Pi model, or set `"current"` to override a global selection. Requests use Pi’s provider and authentication. Unavailable overrides never switch models.

Omit `reasoning` for provider defaults, or choose `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Unsupported levels keep the native call; `/tool-summaries` shows the reason.

Optional settings: `timeoutMs` (8000), `maxInputChars` (24000), `maxTokens` (220), and `concurrency` (2).

Only visible built-in Bash calls in interactive Pi sessions are summarized. Nested calls and replacement Bash tools are skipped. Busy, oversized, or failed requests keep the original view. Summaries are cached in memory, so reopening a session shows original calls. Ctrl+O never makes another request.

Summary requests send the selected tool’s arguments, including the full command, to the selected provider and incur its normal cost.

MIT
