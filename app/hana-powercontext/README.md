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
| Command | `/pc` | `doctor` · `scope` · `memory` · `handoff` |
| Command | `/powercontext` | Alias for `/pc` |

`/pc doctor` answers the one question worth answering first: is the Server there,
and is it ready.

Not in this version: automatic recall injection (the `agent/pre-step` hook) and
the Handoff board card. Those are stages 2 and 3; this App declares no hook
capability words, so installing it grants no hook authority.

## Requirements

- Hana `1.0.0-beta` or newer (`minAppVersion` pins the SDK this was built against).
- A PowerContext Server listening on `http://127.0.0.1:8000`.
- The host must grant `app/tools.expose-to-model`, and the App must be enabled for
  the Agent you want to use it with. Both are user decisions in Hana's own
  permission UI; this App never prompts for them.

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
