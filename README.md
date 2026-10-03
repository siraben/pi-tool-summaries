# Pi Tool Summaries

Plain-language summaries of tool calls.

Collapsed calls show what the agent intends to do: “I’ll search the TypeScript files for `oldApi` and print the matches.” Press **Ctrl+O** to see the entire original command, including multiline scripts and heredocs.

Summaries run in the background using **your currently selected Pi model**. Tool execution and native results stay unchanged. While a summary is pending or unavailable, the original call remains visible.

## Install

Requires **Pi 1.0.0** and Node 22.19+.

```sh
pi install git:github.com/siraben/pi-tool-summaries
```

Restart Pi or run `/reload`. Use `/tool-summaries` to inspect the effective model and status.

## Model selection

The default follows Pi’s model selection for each new call. To use a separate model:

```sh
pi --tool-summary-model openrouter/openai/gpt-6-luna
```

Any model available through Pi’s registry can be used. Requests use Pi’s native provider and authentication infrastructure. Summary requests incur the selected model’s normal cost.

For a persistent override, set both `PI_TOOL_SUMMARY_PROVIDER` and `PI_TOOL_SUMMARY_MODEL`. Precedence is **CLI flag → environment pair → current Pi model**. `--tool-summary-model current` ignores environment overrides. Unavailable overrides retain the original call rather than switching models.

## Configuration and behavior

| Environment variable              | Default                             |
| --------------------------------- | ----------------------------------- |
| `PI_TOOL_SUMMARY_TOOLS`           | `bash,read,edit,write,grep,find,ls` |
| `PI_TOOL_SUMMARY_TIMEOUT_MS`      | `8000`                              |
| `PI_TOOL_SUMMARY_MAX_INPUT_CHARS` | `24000`                             |
| `PI_TOOL_SUMMARY_MAX_TOKENS`      | `220`                               |
| `PI_TOOL_SUMMARY_CONCURRENCY`     | `2`                                 |

Only visible, active built-in tool calls in interactive Pi sessions are summarized; nested calls and existing extension overrides are skipped. Busy, oversized, or failed requests keep the original view. Summaries are cached in memory, so reopening a session shows original calls. Ctrl+O never makes another request.

Summary requests send the selected tool’s arguments, including commands and supplied edit/write content, to the selected provider.

MIT
