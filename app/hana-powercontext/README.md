# PowerContext (hana-powercontext)

A Hana v2 App (`manifestVersion: 2`) that connects a session to a running
[PowerContext](https://github.com/oceanbase/powercontext) Server over HTTP.

The App is deliberately thin: recall, storage, extraction and handoff assembly all
live in the PowerContext Server. What is here is the wiring — and one guarantee:

> **The Server being down degrades this App's answers. It never blocks a session.**

## What it provides

| Surface | Name | What it does |
|---|---|---|
| Tool | `pc_remember` | Write one durable memory entry into a Scope |
| Tool | `pc_memory_list` | Read the entries in a Scope (read-only) |
| Tool | `pc_handoff_prepare` | Finalize a transferable Handoff: capture → prepare → finalize in one call |
| Command | `/pc` | `doctor` · `scope` · `memory` · `hooks` · `handoff` |
| Command | `/powercontext` | Alias for `/pc` |
| Hook | `agent/pre-step` | **Automatic bounded recall before each model step** (stage 2) |
| Hook | `agent/before-start` | Handoff injection at turn start — code only, default off |

`/pc doctor` answers the one question worth answering first: is the Server there,
and is it ready. `/pc hooks` answers the second: is recall actually firing, and
has the user granted the hooks.

Not in this version: the Handoff board card (stage 3).

## Automatic recall (stage 2)

The point of the App. Before each model step the `agent/pre-step` hook asks the
Server for bounded context and, when it gets some, inserts **one** message
immediately before the user's own message:

```
[PowerContext recall · untrusted_history]
<the Server's prepared context, verbatim>
[end recall]
```

Three properties, all deliberate:

- **Nothing existing is touched.** Every other message is passed through by
  reference. Recall is additive; the user's own words stay last, where the model
  looks for the actual request.
- **The wrapper is not decoration.** A recalled passage placed in the transcript
  is otherwise indistinguishable from the user's own words or from an
  instruction. The markers carry that boundary into the model input itself.
- **A failure injects nothing.** Unreachable, timed out, empty, or switched off
  returns "no change" — the turn proceeds exactly as if the App were not
  installed. There is no retry and no queue.

Recall is cached per session for 60 seconds, so a tool loop inside one turn costs
one request rather than one per step.

### Query shaping (stage 2B)

The Server's prepare path matches entities, not questions: sent a whole
natural-language sentence it answers `status: "empty"`, and sent the same
sentence's noun phrase it recalls the entry. Measured four ways in
[`artifacts/stage2/prepare-query-experiment.py`](../../artifacts/stage2/prepare-query-experiment.py),
and side by side against `/v1/memory/search` in
[`artifacts/stage2/query-probe.md`](../../artifacts/stage2/query-probe.md).

So the hook shapes the query before it sends it — `extractRetrievalQuery()` in
`lib/hooks.js`, applied to the last user message:

1. instruction sentences are dropped ("你是一个全新会话。请不要调用任何工具。");
2. brackets, quotes and markup are stripped ("**PowerContext**" → `PowerContext`);
3. stop words are filtered, Chinese and English ("地址是什么", "what is the …");
4. **if nothing usable is left, the original text is sent instead** — the layer
   never invents a query, it only removes noise, so the worst case is the
   behaviour that existed before it.

`PowerContext Server 地址是什么？` therefore reaches the Server as
`PowerContext Server`. The 512-byte cap applies before and after the pass.

Two things it deliberately does **not** touch: the *injected* message (that is
the Server's own prepared block, verbatim) and the *captured* prompt (capture
stores what the user typed, not the retrieval key). `/pc hooks` reports
`extract_hits` and `skipped_empty_extracted` so the layer is observable rather
than assumed.

### Switches

| Key | Env var | Default | Meaning |
|---|---|---|---|
| `prestep` | `POWERCONTEXT_HANA_PRESTEP` | `true` | Kill-switch for recall injection |
| `prestepMaxBytes` | `POWERCONTEXT_HANA_PRESTEP_MAX_BYTES` | `8192` | Recall body budget (protocol max 32768) |
| `prestepTimeoutMs` | `POWERCONTEXT_HANA_PRESTEP_TIMEOUT_MS` | `2000` | Hook-path timeout |
| `capturePrompts` | `POWERCONTEXT_HANA_CAPTURE_PROMPTS` | `false` | Capture user prompts as Sources |
| `captureMaxBytes` | `POWERCONTEXT_HANA_CAPTURE_MAX_BYTES` | `4096` | Per-prompt capture cap |
| `beforeStart` | `POWERCONTEXT_HANA_BEFORE_START` | `false` | Inject the latest committed Handoff at turn start |

Boolean values accept `true/false`, `1/0`, `yes/no`, `on/off`; anything else is
ignored rather than guessed, so a typo in a kill-switch cannot silently read as
"off".

`capturePrompts` is off by default because it writes the user's own prompts to
the Server. When enabled it captures only user prompts — not tool results, not
assistant messages — and skips text it has already captured in the last 32
prompts.

`beforeStart` needs a committed Handoff to inject, which needs a Server with a
generation provider; on a basic-memory Server it is a no-op by construction. See
[the handoff section](#the-handoff-flow-and-its-one-prerequisite).

## Requirements

- Hana `1.0.0-beta` or newer (`minAppVersion` pins the SDK this was built against).
- A PowerContext Server listening on `http://127.0.0.1:8000`.
- The host must grant `app/tools.expose-to-model` and `app/hooks.agent-pre-step`,
  and the App must be enabled for the Agent you want to use it with. All of these
  are user decisions in Hana's own permission UI; this App never prompts for them,
  and it never grants itself anything. Without the hook grant the host simply
  skips this App's adjudicator and the turn proceeds — that is the host's own
  fail-open behaviour, not something the App implements.
- `app/hooks.agent-before-start` is declared but its hook does nothing until
  `beforeStart` is switched on and the Server can produce a Handoff.

## Configuration

Settings resolve per invocation, highest priority first. No restart is needed
after a change.

| Priority | Source |
|---|---|
| 1 | explicit per-call argument (`scope_id`) |
| 2 | `<app-data>/config.json` |
| 3 | environment, prefix `POWERCONTEXT_HANA_` |
| 4 | built-in defaults |

| Key | Env var | Default | Meaning |
|---|---|---|---|
| `baseUrl` | `POWERCONTEXT_HANA_BASE_URL` | `http://127.0.0.1:8000` | Server address |
| `timeoutMs` | `POWERCONTEXT_HANA_TIMEOUT_MS` | `5000` | Per-request budget |
| `scopeId` | `POWERCONTEXT_HANA_SCOPE_ID` | *(empty)* | Scope to use; empty means ask the Server for its default |
| `maxBytes` | `POWERCONTEXT_HANA_MAX_BYTES` | `8000` | Recall byte budget (Server range 512–32768) |
| `maxResponseBytes` | `POWERCONTEXT_HANA_MAX_RESPONSE_BYTES` | `32768` | Response cap |

`baseUrl` must stay within the manifest's declared network door:
`allowedHosts: ["127.0.0.1"]`, `allowLocalhost: true`, `methods: ["GET","POST"]`.
Pointing it at a host outside that list is refused by the host, not by this App.

## The trust boundary

The Server returns historical context labelled as **untrusted history**, and this
App does not launder that. Three consequences are built into the tool contracts:

- `pc_handoff_prepare` writes the caller's own words into the boundary Source and
  lets the **Server** generate the Draft from them. Neither side verifies those
  claims; the tool says so rather than implying otherwise.
- `pc_handoff_prepare` performs a **temporary** transfer. It never calls
  `/v1/handoff/commit`, which is the durable-milestone operation and belongs to an
  explicit user request.
- Nothing in this App writes messages, rewrites prompts, or touches a session. Its
  only power is the three tools and one command, all of which a user can revoke.

### The handoff flow, and its one prerequisite

`pc_handoff_prepare` runs the Server's explicit Handoff flow in three calls:

```
POST /v1/sources/content     the boundary text becomes a real Source
POST /v1/handoff/prepare     evidence cites that exact Source; Server generates a Draft
POST /v1/handoff/finalize    the Draft becomes the transferable value (details.finalized)
```

The middle step is **model-driven on the Server**, so it needs a generation
provider. On a basic-memory Server — where `/v1/capabilities` reports
`handoff_generation: false` — the tool reports a structured
`handoff_generation_unavailable` error and states plainly that the boundary Source
was already captured, so the work is not lost. `/pc doctor` shows the Server's
capabilities if you need to check. This is a Server configuration matter, not an
App fault: configure a generation provider to get finalized Handoffs.

## Development

```sh
# Logic check, no Hana and no Server needed. 117 assertions, including the full
# three-step handoff flow and every failure branch. The live section at the end is
# skipped automatically when no Server is reachable.
node lib/selftest.mjs

# The stage 2 hooks driven the way the host drives them: registration through
# sdk.hooks.onDecision, then a real pre-step invocation. Offline and deterministic.
node lib/hook-probe.mjs

# Real round trip through the App's own code against a live Server.
# Provisions a Scope of its own; it never writes into a Scope it did not create.
# Asserts the handoff path the Server actually owes, based on its own reported
# handoff_generation capability.
node lib/live-demo.mjs

# Negative case: same tools, pointed at a port where nothing is listening.
node lib/live-demo.mjs --fail-open

# The handoff flow's third step, against a local Server that speaks the four
# endpoints with a generation provider simulated. Real sockets, real payloads.
node lib/finalize-probe.mjs

# Repeated handoffs must not collide on the boundary Source id.
node lib/burst-probe.mjs <scope-id> 10
```

## Validate

```sh
# Static package validation.
HANA_APP_TOOLS_ROOT=<hana-server-dir> \
  node <skill-dir>/scripts/validate_app.mjs --dir . --json

# Isolated startup, in the host's own AppHost.
HANA_APP_TOOLS_ROOT=<hana-server-dir> \
  node <hana-server-dir>/scripts/validate-app.mjs --dir . --smoke --json
```

`HANA_APP_TOOLS_ROOT` is required by both: each script resolves the Hana Server
toolchain before it will run, and reports `author_tools_unavailable` without it.

Note on the smoke check: it composes no slash-command registry, so `/pc` cannot
register there. Command registration is therefore deferred past the load window
and fully caught, so that it can never affect whether the App loads. The tools are
the contract; `/pc` is a convenience over the same functions.

## Install

1. Copy this directory to `<HANA_HOME>/apps/hana-powercontext/`.
2. Restart Hana, or reload the App from App Manager.
3. Complete the review, approving `app/tools.expose-to-model` and the
   `127.0.0.1` network declaration.
4. Enable the App for the Agent you want to use it with.

Uninstalling removes `apps/hana-powercontext`; `app-data/hana-powercontext` is
preserved, which is where a config override would live.

## License

Apache-2.0, matching upstream PowerContext. This App contains no upstream code —
it depends only on the Server's HTTP contract.
