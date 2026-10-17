# Pi Tool Summaries

![Before: a fail-fast Bash workflow that bootstraps RISC-V stage0 tools under QEMU. After: its Haiku 5.5-generated plain-language summary.](docs/before-after.svg)

Plain-language summaries of Bash, PowerShell and codemode tool calls.

## Install

Requires **Pi >=0.84.4 <2** and **Node >=22.19**. PowerShell and codemode summaries require Pi >=1.0.1. See [compatibility](docs/compatibility.md) for supported environments and tests.

```sh
pi install npm:pi-tool-summaries
```

Restart Pi or run `/reload`. Summaries use your current Pi model and its authentication. `/tool-summaries` shows the model, usage and status.

**Privacy:** full tool arguments go to the summary provider, including any inline credentials or private code. Requests can incur provider charges or consume subscription quota. Use `/tool-summaries off` to pause requests or set `"toolSummaries": { "enabled": false }` to disable them in settings.

## Before and after

Press **Ctrl+O** to expand the original command. Tool results remain unchanged. Summaries describe intended actions, not verified execution or safety.

### Compare compiler binaries

<details>
<summary>Before: full Bash command</summary>

```sh
cat > /tmp/blynn-structural/compare-tinycc.py <<'PY'
"""Compare artifacts; normalize only the exact expected installation prefix."""
from pathlib import Path
import hashlib,json
old=Path('/nix/store/616qf0b4c1jpfd45i9g9zss94gcgya48-tinycc-boot-hcc-m2-precisely-m2-unstable-2025-12-03')
new=Path('/nix/store/4mjpbm5w9246lig1lhm8p2wxmn3j0vzq-tinycc-boot-hcc-m2-precisely-m2-unstable-2025-12-03')
rows=[]
for name in ['bin/tcc-hcc-stage1','bin/tcc-stage2','bin/tcc']:
 a,b=(x.joinpath(name).read_bytes() for x in (old,new))
 assert a.count(str(old).encode())==b.count(str(new).encode())==1
 assert a.replace(str(old).encode(),str(new).encode())==b
 rows.append(dict(file=name,bytes=len(a),baseline_sha256=hashlib.sha256(a).hexdigest(),candidate_sha256=hashlib.sha256(b).hexdigest(),equal_after_own_store_prefix_normalization=True))
print(json.dumps(dict(baseline=str(old),candidate=str(new),artifacts=rows),indent=2))
PY
python3 /tmp/blynn-structural/compare-tinycc.py > /tmp/blynn-structural/tinycc-artifacts.json
```

</details>

**After:**

> Writing a Python script to /tmp that checks three TinyCC binaries across two Nix store outputs, asserts they match after replacing only the store prefix, and saves their sizes and SHA-256 hashes to tinycc-artifacts.json.

### Check benchmark results

<details>
<summary>Before: full Bash command</summary>

```sh
python3 - <<'PY'
import json,statistics,pathlib
root=pathlib.Path('/tmp/blynn-ablation-20260921')
r=json.loads((root/'summary.json').read_text())
cs=[x['first_selfhost_seconds'] for x in r if x['variant']=='control']
b=statistics.mean(cs)
print('CONTROL',cs,'mean',b,'range',max(cs)-min(cs),'stdev',statistics.stdev(cs))
for x in r:
 print(x['variant'],x['first_selfhost_seconds'],round(x['first_selfhost_seconds']-b,2),round(100*(x['first_selfhost_seconds']/b-1),2),x['derivations'])
assert len(r)==12
for x in r:
 assert x['artifacts']['bin/tcc-stage2']['sha256']==x['artifacts']['bin/tcc']['sha256']
 for p in x['artifacts']:
  assert x['artifacts'][p]['normalized_sha256']==r[0]['artifacts'][p]['normalized_sha256']
print('Verified every TinyCC artifact and fixed point.')
for x in r:
 rows=[s.split('\t') for s in (root/'results'/(x['label']+'.tsv')).read_text().splitlines()]
 group={k:0 for k in ['seed','raw','party','hcc','tinycc','other']}
 for row in rows:
  n=row[1];t=float(row[2]);g='other'
  if 'tinycc-' in n:g='tinycc'
  elif 'hcc-blynn-' in n or n.startswith('hcc-m2-'):g='hcc'
  elif 'blynn-upstream-' in n:g='party'
  elif 'blynn-' in n and any(a in n for a in ['raw-','marginally-','methodically-','vm-','blob-','pack-blobs-']):g='raw'
  elif not 'blynn-' in n and not 'mes-libc' in n:g='seed'
  group[g]+=t
 print(x['label'],{k:round(v,2) for k,v in group.items()})
PY
```

</details>

**After:**

> Comparing the first self-host timings of 12 Blynn ablation variants against the control mean and spread, asserting that every TinyCC artifact and normalized hash matches (aborting if not), and totaling each variant's per-step durations by category from its TSV file.

## Commands

| Command                                      | Action                                                              |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `/tool-summaries`                            | Show model, usage and status                                        |
| `/tool-summaries on`, `off`, `toggle`        | Enable or pause requests for the current runtime session            |
| `/tool-summaries backfill [count] [--force]` | Summarize earlier calls on the current branch; default 100 messages |

Backfill scans all message roles, skips existing summaries unless `--force` is set, and applies the same input limits as live calls. It sends one request at a time using the model selected when backfill starts. It stops if that model enters a cooldown and never executes recorded commands.

Pausing cancels live requests and backfill. Saved summaries remain visible. Cancellation does not undo data already sent or charges incurred.

## Configuration

Add `toolSummaries` to Pi's `settings.json` in `~/.pi/agent/` or your custom agent directory. Trusted project `.pi/settings.json` values override global settings. Run `/reload` after editing.

```json
{
  "toolSummaries": {
    "model": "current",
    "enabled": true
  }
}
```

| Setting           | Default          | Meaning                                                     |
| ----------------- | ---------------- | ----------------------------------------------------------- |
| `model`           | `"current"`      | Current Pi model, or a dedicated `provider/model-id`        |
| `enabled`         | `true`           | Generate summaries                                          |
| `reasoning`       | Provider default | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `minCommandChars` | `150`            | Minimum command/script length; `0` summarizes every call    |
| `timeoutMs`       | `8000`           | Request timeout                                             |
| `maxInputChars`   | `24000`          | Maximum serialized input length                             |
| `maxTokens`       | `1024`           | Requested output-token limit                                |
| `concurrency`     | `2`              | Maximum concurrent summary requests                         |

### Models and authentication

`"model": "current"` uses the active Pi model and its API-key, subscription/OAuth or ambient credentials. An explicit model uses that provider's authentication through Pi. Unavailable selections never switch models or providers. Unsupported reasoning levels leave the original call visible.

For Haiku through OpenRouter, create an [OpenRouter API key](https://openrouter.ai/settings/keys), fund the account, and authenticate OpenRouter through Pi's `/login` or the `OPENROUTER_API_KEY` environment variable. Set the variable before starting Pi, then configure:

```json
{
  "toolSummaries": {
    "model": "openrouter/anthropic/claude-haiku-5.5"
  }
}
```

A ChatGPT/Codex login or direct Anthropic key does not authenticate OpenRouter. Local endpoints use Pi's `models.json`; see [Pi's model setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md). Keep credentials in Pi's authentication configuration or environment, not `toolSummaries`.

Pi resolves authentication when a request is sent. Authentication/access errors and HTTP 429 responses start a 60-second per-model cooldown; three consecutive provider failures do the same. A failure is notified once per model per runtime session. Fix credentials with Pi's `/login` and wait for the cooldown, or run `/reload`. The extension does not retry failed requests automatically or display raw provider errors.

Disable requests for sensitive projects. Tool results and conversation history are not sent by this extension.

### Usage

Usage reports include generation attempts, provider-reported tokens and estimated USD cost, including failed attempts and unusable responses when usage is available. Estimates can be incomplete and are not billing totals; zero reported cost does not establish that a request is free. Counters are separate from Pi's conversation totals.

`maxTokens` limits requested output, not total input or reasoning cost; provider support varies. Usage counters, cooldowns and runtime toggles reset on reload, restart or session replacement. The configured `enabled` value applies again.

## Scope and storage

Summaries apply to visible built-in Bash/PowerShell calls and active codemode calls in interactive Pi sessions. Nested calls, replacement shell tools and print/JSON/RPC/SDK sessions retain native behavior. Busy, oversized or failed requests leave the original call visible. Rendering uses Pi's active theme.

Successful summaries are saved in Pi's session JSONL and restored on reload or resume. With `--no-session`, they remain in memory. Ctrl+O does not generate another request.

MIT
