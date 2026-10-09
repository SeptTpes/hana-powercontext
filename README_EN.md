# hana-powercontext

**PowerContext for HanaAgent** — pull-style memory tools, per-step automatic recall injection, and a handoff dashboard: work context that follows the task, not the session.

[中文](README.md) · English

> hana-powercontext is a HanaAgent (openhanako) v2 App integration for [OceanBase PowerContext](https://github.com/oceanbase/powercontext). The upstream official integrations list (Codex / Claude Code / DSH / OpenCode / …) has no HanaAgent entry — this repository fills that gap.

## What problem it solves

When an agent session ends, its reasoning and state stay behind in that session. Starting over means re-explaining — for you and for the agent. HanaAgent has cross-session retrieval built in (pull-style: the agent must remember to look); this project adds the **push-style** half:

- **Automatic recall before every model step**: an `agent/pre-step` hook asks the PowerContext Server for bounded context (reusing a cached answer for 60s) and injects it, wrapped in an explicit `[PowerContext recall · untrusted_history]` fence — a brand-new session knows what was remembered before **its first sentence**, with no ceremony.
- **Pull-style tools**: `pc_remember` / `pc_memory_list` / `pc_handoff_prepare` cover explicit memory and handoffs.
- **Handoff dashboard**: a chalkboard card that fetches the current Scope, latest Handoff, memory inventory, Server status and hook counters when you open it and when you refresh — it does not poll.

All recalled content is forcibly wrapped as `untrusted_history` (data, not instructions); current user / repository / system instructions always take precedence.

## Capability matrix

| Capability | Mechanism | Status |
|---|---|---|
| Cross-session pull memory | agent tools → Server | ✅ verified on real host |
| Cross-session push recall | `agent/pre-step` hook + query extraction layer | ✅ verified (desktop & Bridge sessions) |
| Subagent isolated sessions | pre-step does not fire (engine-level boundary); pull tools cover it | tested & recorded |
| Work Handoff | capture → prepare → finalize explicit flow | ✅ (finalized carrier needs full mode, see below) |
| Dashboard card | `contributes.cards` + backend routes (read-only toward the Server; `/prefs` writes only the App's own preference) | ✅ |
| Prompt capture as Source | `POWERCONTEXT_HANA_CAPTURE_PROMPTS`, **off by default** | opt-in; **capture is independent of the recall result** — any step with new user text is captured, and it is skipped when the Server is unreachable |
| Review gate | `/pc review` — human-only; no review tools on the model surface | ✅ |

## Requirements

- [HanaAgent (openhanako)](https://github.com/liliMozi/openhanako) **1.0.0-beta+** (v2 App system)
- [PowerContext Server](https://github.com/oceanbase/powercontext) **v1.2.0** (installed separately; this plugin never bundles or modifies it)
- Python 3.11+ and [uv](https://docs.astral.sh/uv/) (Server side)
- macOS / Linux (Windows untested)

## Install

### 1. PowerContext Server (once)

```bash
uv tool install --force "powercontext[cli,server]==1.2.0"
mkdir powercontext-config && cd powercontext-config
powercontext config init            # choose Basic memory; covers all core capabilities
powercontext server run             # default http://127.0.0.1:8000
```

> full mode (adding Generation/Embedding credentials) unlocks the complete finalized Handoff carrier and automatic Topic Memory; Basic memory already covers memory / recall / boundary capture.

### 2. This App

```bash
git clone https://github.com/SeptTpes/hana-powercontext.git
cd hana-powercontext
```

HanaAgent → Extension manager → install from local directory (or from the release zip) → select `app/hana-powercontext` → review the panel (expect exactly 3 capability grants + a 127.0.0.1 network block; anything more — refuse and open an issue).

> After installing, **enable the App in the settings of each Agent you want to use it with** — until then the `/pc` command family is not visible to that Agent. The command entry point is `/pc`; `/powercontext` is its alias.

### 3. Verify in three steps

```bash
# ① connectivity
/pc doctor            # → status: ready
# ② memory loop (have the model remember something; open a new session and ask)
# ③ push check: first sentence of a new session asks "what address did I have you remember"
#    — the model must NOT call any tool for the answer to appear
```

## Configuration (env vars; override chain: call args > app-data config.json > env > defaults)

| Key | Env var | Default | Meaning |
|---|---|---|---|
| `prestep` | `POWERCONTEXT_HANA_PRESTEP` | `true` | push-injection master switch |
| `prestepMaxBytes` | `…_PRESTEP_MAX_BYTES` | `8192` | recall body budget (protocol cap 32768) |
| `prestepTimeoutMs` | `…_PRESTEP_TIMEOUT_MS` | `2000` | prepare timeout |
| `capturePrompts` | `…_CAPTURE_PROMPTS` | `false` | capture user prompts as Sources (writes prompts to the Server; off by default) |
| `captureMaxBytes` | `…_CAPTURE_MAX_BYTES` | `4096` | per-capture cap |
| `beforeStart` | `…_BEFORE_START` | `false` | inject latest Handoff at session start (needs full mode) |
| `baseUrl` | `POWERCONTEXT_HANA_BASE_URL` | `http://127.0.0.1:8000` | Server address (change this if the port is taken) |

Slash commands: `/pc doctor` (connectivity & readiness) · `/pc scope` · `/pc memory` · `/pc handoff` · `/pc hooks` (injection counters & grant ledger) · `/pc review` (human gate). Full key table in [`app/hana-powercontext/README.md`](app/hana-powercontext/README.md).

## Architecture, one picture

```
┌─ HanaAgent host ─────────────────────────────────────────┐
│  chat session ──model step──> [agent/pre-step hook] ──┐  │
│     ↑ bounded recall injected            │            │  │
│       (untrusted-history fence)          │            │  │
│  dashboard card ──backend routes         │            │  │
│       (status/handoff/memory/hooks/prefs)┤            │  │
│  pc_* tools ─────────────────────────────┤            │  │
│  /pc commands ───────────────────────────┴──> PowerContext Server (Python)
└──────────────────────────────────────────────────────────┘
                                    └── cross-harness: Codex / Claude Code /
                                        DSH official integrations share the Server
```

Design invariants: **fail-open** (Server down → no injection / tools answer with clear errors; the session proceeds); **credential minimisation** (the App never sets credential headers itself — covered by dedicated assertions; stripping inbound credential material is the host route proxy's job, a host contract documented in HanaAgent's APPS.md); **privacy off by default** (prompt capture is opt-in); **citation boundary** (recalled history is always quarantined data, never dressed as instructions).

## Known limitations (stated plainly)

- **Subagent isolated sessions do not fire pre-step** (host engine boundary): isolated-session continuation goes through pull tools.
- **The finalized Handoff carrier** (the full prepare→finalize output) needs a generation provider on the Server (full mode); on Basic memory the tool honestly reports `handoff_generation_unavailable` and records the boundary Source.
- **Smoke validation** fails in the isolated AppHost composition (SDK entry precheck; no App code executes) while real-host loads are fine — verification therefore keys on real-host load logs.
- **Recall injection is per-step and transient; it is not written to the session record.** The host replays it each step, which is why reviewing a past session will not show the recalled content.
- Recall matching is token-level: full natural-language questions may miss (the App ships a query-extraction layer to mitigate).
- **The finalize positive path currently has only local simulation evidence** (the selftest stub plus `finalize-probe`'s simulated generation provider). The honest capability gate on Basic memory and the boundary Source are real-host verified.
- **`/pc review approve|reject` has never run against a real Candidate** (those need full mode to produce one). What is verified is the gate's construction — no review tool on the model surface — and that rests on code and assertions.

## Verification system

This repo treats acceptance as a first-class artifact: `lib/selftest.mjs` (519 checks, including the live section) / `lib/dashboard-probe.mjs` (250) / `lib/hook-probe.mjs` (131) / `lib/live-demo.mjs` (end-to-end against a real Server) / `scripts/verify-fail-open.sh` (degradation semantics). Some acceptance criteria (the capture-enabled side, the kill-switch, the real-host outage hook path) currently rest on **offline assertions only** and have not been exercised on real hardware; see [`docs/VERIFICATION.md`](docs/VERIFICATION.md) for how to re-run them offline.

## License

[Apache-2.0](LICENSE). This project contains no PowerContext or openhanako source code; runtime dependencies are installed separately. Attribution in [NOTICE](NOTICE).

## Acknowledgements

- [OceanBase PowerContext](https://github.com/oceanbase/powercontext) — the work-context system itself, and its official DSH integration (this project's contract reference);
- [dsh-powercontext](https://github.com/yangyizhu8/dsh-powercontext) — prior art for the DeepSeek Harness integration;
- [liliMozi/openhanako](https://github.com/liliMozi/openhanako) — HanaAgent and the v2 App system.
