# Compatibility

- Pi >=0.84.4 <2; PowerShell and codemode summaries require Pi >=1.0.1.
- Node >=22.19; CI checks Node 22 and 24.
- Interactive Pi sessions only. Print/JSON/RPC/SDK sessions retain native behavior.
- Built-in Bash/PowerShell and active codemode calls only. Replacement shell tools remain native.

Pi supplies the model registry, authentication, shell execution and theme. Renderer registration wraps existing tool renderers on Pi >=1.0.1; older Pi uses a Bash compatibility wrapper. Production code does not import Pi's private UI modules.

## Verification

```sh
npx --yes npm@12.2.0 ci --ignore-scripts
npm run check
npm test
npm run format:check
npm run test:package
```

Tests check configuration, model selection, on/off controls, backfill, persistence, cancellation, rendering and provider calls. They use direct results and controlled promises, not latency assertions or prompt-text snapshots. One local HTTP endpoint exercises Pi's actual request/authentication path without paid calls. Native shell execution runs Bash on Unix and PowerShell on Windows; WSL is not covered.

CI runs the suite on Linux, macOS and Windows, with an additional Linux Node 24 job and Linux Pi 0.84.4/1.3.0 jobs. The development version is pinned to Pi 1.0.1. Compatibility checks cover the declared APIs, not every live provider's model access or billing.

`test:package` packs the package, installs the tarball in a temporary directory without host peers, and loads the installed entry point through Pi. `npm publish` runs the checks through `prepublishOnly`; these checks do not run when users install the package. Pi loads TypeScript directly, so no compilation step is required.

Live checks (`npm run test:live`) require Pi credentials and can incur costs. Standalone scripts use Pi's saved default when `model` is `current`, since they have no running session model.
