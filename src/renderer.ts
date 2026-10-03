import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Summaries } from "./summaries.js";

/** Only replaces the call renderer. Execute, schema, metadata and result renderer stay intact. */
export function withSummary(
  original: ToolDefinition<any, any, any>,
  summaries: Summaries,
): ToolDefinition<any, any, any> {
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
        original.name,
        args,
        context.invalidate,
      );
      const title = theme.fg("toolTitle", theme.bold(original.label));
      if (!context.expanded && entry.summary) {
        return new Text(`${title}\n${entry.summary}`, 0, 0);
      }
      return native;
    },
  };
}
