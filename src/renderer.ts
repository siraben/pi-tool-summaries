import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Summaries } from "./summaries.js";

type ToolRenderers = Pick<
  ToolDefinition<any, any, any>,
  "renderCall" | "renderResult"
> & { renderShell?: "default" | "self" };

/** Wrap renderers without changing execution, schema, metadata, or result rendering. */
export function withSummaryRenderers(
  original: ToolRenderers,
  name: string,
  label: string,
  summaries: Summaries,
): ToolRenderers {
  if (!original.renderCall) return original;
  // Keep native components separate from summary components across redraws/toggles.
  // The row owns renderer state, so a WeakMap follows its lifetime without retaining sessions.
  const nativeComponents = new WeakMap<
    object,
    ReturnType<NonNullable<typeof original.renderCall>>
  >();
  return {
    ...original,
    renderCall(args, theme, context) {
      // Native renderCall maintains state used by native result renderers (e.g. bash elapsed time).
      const native = original.renderCall!(args, theme, {
        ...context,
        lastComponent: nativeComponents.get(context.state),
      });
      nativeComponents.set(context.state, native);
      const entry = summaries.view(
        context.toolCallId,
        name,
        args,
        context.invalidate,
      );
      const title = theme.fg("toolTitle", theme.bold(label));
      if (!context.expanded && entry.summary) {
        return new Text(`${title}\n${entry.summary}`, 0, 0);
      }
      return native;
    },
  };
}

/** Only replaces a tool definition's call renderer. */
export function withSummary(
  original: ToolDefinition<any, any, any>,
  summaries: Summaries,
): ToolDefinition<any, any, any> {
  return {
    ...original,
    ...withSummaryRenderers(original, original.name, original.label, summaries),
  };
}
