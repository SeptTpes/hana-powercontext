# PowerContext (hana-powercontext)

**This is the brief shipped inside the App package.** The authoritative document —
installation, configuration, trust boundary and known limitations — is the
repository root [`README.md`](../../README.md). If you have just cloned the repo,
start there.

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
| Command | `/pc` | `doctor` · `scope` · `memory` · `hooks` · `handoff` · `review` |
| Command | `/powercontext` | Alias for `/pc` |
| Hook | `agent/pre-step` | **Automatic bounded recall before each model step** |
| Hook | `agent/before-start` | Handoff injection at turn start — code only, default off |
| Card | **PowerContext 看板** | Scope, latest Handoff, memory list and Server state on a Hana board |

`/pc doctor` answers the one question worth answering first: is the Server there,
and is it ready. `/pc hooks` answers the second: is recall actually firing, and
has the user granted the hooks. The dashboard card answers both at a glance,
without typing anything.

## The dashboard card

A chalkboard card that makes the App's state visible instead of leaving it in a
black box: the effective Scope, the latest Handoff, the memory inventory and the
Server's reachability — on one surface, refreshed when you ask it to.

Three rules it follows:

- **The card never talks to the PowerContext Server.** It calls this App's own
  backend (`<app>/routes/{status,handoff,memory,hooks,prefs}`), which reuses the
  same Scope resolution, network declaration, timeout and fail-open behaviour as
  the tools. One place to get the connection right, not two.
- **The Server-facing routes are read-only.** The only route that writes anything
  is `/prefs`, and it writes one thing: this App's own collapse preference, into
  the App's own app-data. Nothing the card does can write to the Server.
- **A failure explains itself.** When the Server is down the card shows what
  happened, which address it tried, and how to fix it — instead of an empty panel
  that looks like a bug. An empty memory list teaches `pc_remember`; an empty
  Handoff section teaches `pc_handoff_prepare`. It also says "showing 10 of 43"
  rather than implying it shows everything.

The card fetches once when it mounts and then only when you press 刷新. It does not
poll: a card that polls puts a permanent load on the Server for a surface you may
not even be looking at. Section collapse state is persisted in the App's own
app-data (`prefs.json` via the `/prefs` route), so it survives closing the card,
host restarts, and reinstalling the App; the data itself is never cached, so what
you see is what the Server said on the last refresh.

## Collapse preference (`/prefs`)

Sections remember whether you collapsed them. That preference is **not** card
instance state — it is stored in the App's app-data directory and read back on
every mount, which is why it survives a remount (the earlier attempt stored it in
`hana.state`, whose lifetime is the card instance, so it never could).

`prefs.json` contains booleans for the collapsible sections and nothing else: no
Server data, no Scope id, no credential, no user text.

## Review is a human decision

`/pc review` lists pending Artifact Candidates and `/pc review approve|reject`
decides them. **No review operation is exposed as a model-callable tool**, and
none ever will be: approving a Candidate publishes a generated artifact, and a
model that could approve its own proposals would be reviewing its own work. A
slash command can only be typed by a person, so that is the only door.

A version conflict is reported, not retried — the decision has to land on the
revision you actually looked at.

## Automatic recall

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

Capture is **independent of whether recall matched**: any step carrying new user
text is captured, including a first message or a subject the Server knows nothing
about yet. It is skipped only when the Server is unreachable — capture is a write,
and a write cannot succeed where the read just failed.

`capturePrompts` is off by default because it writes the user's own prompts to
the Server. When enabled it captures only user prompts — not tool results, not
assistant messages — and skips text it has already captured in the last 32
prompts.

For the full key table, override chain and trust boundary, see the root
[`README.md`](../../README.md).

## Requirements

- Hana `1.0.0-beta` or newer (`minAppVersion` pins the SDK this was built against).
- A PowerContext Server v1.2.0 listening on `http://127.0.0.1:8000`, installed
  separately — see the root [`README.md`](../../README.md).
- The host must grant `app/tools.expose-to-model` and `app/hooks.agent-pre-step`,
  and the App must be enabled for the Agent you want to use it with. All of these
  are user decisions in Hana's own permission UI; this App never prompts for them,
  and it never grants itself anything.

## Install

HanaAgent → Extension manager → **install from local directory** (choose
`app/hana-powercontext`) or **install from the release zip**. Then:

1. Complete the review panel. **Expected exactly 3 capability grants plus a
   `127.0.0.1` network block.** Anything more — refuse and open an issue.
2. **Enable the App for the Agent you want to use it with.** Until it is enabled
   for that Agent, the `/pc` command family is not visible to it.
3. Check connectivity with `/pc doctor`.

Uninstalling removes the App directory; its app-data (including `prefs.json`, and
a config override if you made one) is preserved.

## Development and validation

```sh
# Logic check, no Hana and no Server needed. 519 assertions, including the full
# three-step handoff flow and every failure branch. The live section at the end is
# skipped automatically when no Server is reachable.
node lib/selftest.mjs

# The card's backend aggregation and its view logic — what the card says for a
# healthy Server, an empty Scope, and an outage. 250 assertions; the rendered page
# needs a host, these decisions are pure functions and do not.
node lib/dashboard-probe.mjs

# The hooks driven the way the host drives them: registration through
# sdk.hooks.onDecision, then a real pre-step invocation. 131 assertions, offline
# and deterministic.
node lib/hook-probe.mjs
```

Full validation (static package check and the isolated smoke composition) is
documented in the root [`README.md`](../../README.md).

## Known limitations

Stated plainly, and mirrored in the root README so the two cannot diverge:

- **Subagent isolated sessions do not fire pre-step** (host engine boundary):
  isolated-session continuation goes through the pull tools.
- **The finalized Handoff carrier** (the full prepare→finalize output) needs a
  generation provider on the Server (full mode); on Basic memory the tool honestly
  reports `handoff_generation_unavailable` and records the boundary Source.
  **The finalize positive path currently has only local simulation evidence** —
  the selftest stub and `finalize-probe`'s simulated generation provider. The
  honest capability gate on Basic memory and the boundary Source are
  real-host verified; the finalized carrier itself is not.
- **Smoke validation** fails in the isolated AppHost composition (SDK entry
  precheck; no App code executes) while real-host loads are fine — verification
  therefore keys on real-host load logs.
- Recall matching is token-level: full natural-language questions may miss (the
  App ships a query-extraction layer to mitigate).
- **`/pc review approve|reject` has never run against a real Candidate** — those
  need full mode to produce one. What is verified is the gate's construction: the
  model tool surface contains no review tool, and that is covered by assertions
  rather than by a live approval.

## License

Apache-2.0, matching upstream PowerContext. This App contains no upstream code —
it depends only on the Server's HTTP contract.
