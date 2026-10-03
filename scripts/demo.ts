import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  ModelRegistry,
  ModelRuntime,
  createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  TuiMainScreen,
  ProcessTerminal,
  Text,
  matchesKey,
  setKeybindings,
} from "@earendil-works/pi-tui";
import { configFromSettings } from "../src/config.js";
import { createGenerate } from "../src/provider.js";
import { Summaries } from "../src/summaries.js";
import { withSummary } from "../src/renderer.js";

// The demo deliberately uses Pi's pinned native component; the extension itself uses only public APIs.
const dist = dirname(
  fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const { initTheme } = await import(
  pathToFileURL(join(dist, "modes/interactive/theme/theme.js")).href
);
const { ToolExecutionComponent } = await import(
  pathToFileURL(join(dist, "modes/interactive/components/tool-execution.js"))
    .href
);
initTheme("dark", false);
const { KeybindingsManager } = await import(
  pathToFileURL(join(dist, "core/keybindings.js")).href
);
setKeybindings(new KeybindingsManager());

const config = configFromSettings(
  SettingsManager.create(process.cwd(), undefined, { projectTrusted: false }),
);
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const registry = new ModelRegistry(runtime);
const model =
  config.provider && config.model
    ? registry.find(config.provider, config.model)
    : undefined;
if (!model || !registry.hasConfiguredAuth(model)) {
  console.error(
    "Configure the summary model and Pi credential before running the demo.",
  );
  process.exit(1);
}
const command = `printf 'TypeScript source files:\\n'
find src \\
  -type f \\
  -name '*.ts' \\
  -not -path '*/generated/*' \\
  -print |
  sort`;
const args = { command };
const once = process.argv.includes("--once");
if (!once && !process.stdin.isTTY) {
  console.error(
    "Run this demo in a terminal, or add --once to print both views.",
  );
  process.exit(1);
}
const ui = once ? undefined : new TuiMainScreen(new ProcessTerminal());
const summaries = new Summaries(
  config,
  createGenerate(registry, model, config.maxTokens),
);
const original = createBashToolDefinition(process.cwd(), {
  exposeSessionEnvironment: false,
});
const tool = withSummary(original, summaries);
const row = new ToolExecutionComponent(
  "bash",
  "demo",
  args,
  {},
  tool,
  {
    requestRender() {
      ui?.requestRender();
    },
  },
  process.cwd(),
);
row.setArgsComplete();
row.markExecutionStarted();
let expanded = false;
if (ui) {
  ui.addChild(
    new Text(
      `Live Pi renderer demo — ${config.provider}/${config.model}\nCtrl+O: toggle full command   q: exit\nThe displayed command only lists this project's TypeScript source files.`,
      0,
      0,
    ),
  );
  ui.addChild(row);
  ui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+o")) {
      expanded = !expanded;
      row.setExpanded(expanded);
      ui.requestRender();
      return { consume: true };
    }
    if (data === "q" || matchesKey(data, "ctrl+c")) {
      summaries.dispose();
      ui.stop();
      process.exit(0);
    }
    return undefined;
  });
  ui.start();
}
const started = Date.now();
summaries.start("demo", "bash", args);
const result = await original.execute(
  "demo",
  args,
  undefined,
  undefined,
  undefined as never,
);
row.updateResult({ ...result, isError: false });
ui?.requestRender();
// Ignore preliminary native execution redraws; wait for the summary's terminal state.
while (
  summaries.view("demo", "bash", args, () => {
    row.invalidate();
    ui?.requestRender();
  }).status === "pending"
) {
  if (Date.now() - started > config.timeoutMs + 1000) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (once) {
  const render = () => stripVTControlCharacters(row.render(100).join("\n"));
  console.log(`Live model: ${config.provider}/${config.model}`);
  console.log(`Summary time: ${Date.now() - started} ms`);
  console.log("\nCOLLAPSED VIEW");
  console.log(render());
  row.setExpanded(true);
  console.log("\nEXPANDED VIEW (Ctrl+O in interactive mode)");
  console.log(render());
  summaries.dispose();
}
