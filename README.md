# hana-powercontext

**PowerContext for HanaAgent** — 拉式记忆工具 + 每步自动召回注入 + 交接看板，让「工作上下文」跟着任务走，而不是跟会话走。

[English](README_EN.md) · 中文

> hana-powercontext 是 [OceanBase PowerContext](https://github.com/oceanbase/powercontext) 的 [HanaAgent (openhanako)](https://github.com/liliMozi/openhanako) v2 App 集成。上游官方 integrations 列表（Codex / Claude Code / DSH / OpenCode 等）不含 HanaAgent，本仓库填补这个空位。

## 它解决什么问题

Agent 的工作会话结束后，推理与状态留在会话里。开新会话接手时，人要重新交代，Agent 要重新摸索。HanaAgent 原生有跨会话检索（拉式：靠 Agent 记得去查），本项目补上**推式**的一半：

- **每步自动召回**：`agent/pre-step` 钩子在每个模型步之前（60s 内复用缓存）向 PowerContext Server 取有界上下文，以 `[PowerContext recall · untrusted_history]` 显式包裹注入——新会话**第一句话**就能拿到之前记住的东西，无需任何主动查询；
- **拉式工具**：`pc_remember` / `pc_memory_list` / `pc_handoff_prepare` 三个工具覆盖显式记忆与交接；
- **交接看板**：黑板卡片呈现（打开即取最新，手动刷新）Scope、最新 Handoff、记忆清单、Server 状态与钩子计数。

所有召回内容强制标注 `untrusted_history`（数据而非指令），当前用户 / 仓库 / 系统指令始终优先。

## 功能矩阵

| 能力 | 机制 | 状态 |
|---|---|---|
| 跨会话拉式记忆 | `agent` 工具调用 Server | ✅ 真机验证 |
| 跨会话推式召回注入 | `agent/pre-step` 钩子 + query 提炼层 | ✅ 真机验证（桌面/Bridge 会话） |
| subagent 隔离会话 | 不触发 pre-step（引擎级边界），走拉式工具互补 | 实测记录 |
| 工作交接（Handoff） | capture → prepare → finalize 显式交接流 | ✅（finalized 载体需 full 模式，见下） |
| 看板卡 | `contributes.cards` + 后端路由（对 Server 只读；`/prefs` 仅写 App 自身偏好） | ✅ |
| 输入捕获为 Source | `POWERCONTEXT_HANA_CAPTURE_PROMPTS`，**默认关** | 显式开启后生效 |
| 审阅门禁 | `/pc review` 仅人手触发，模型工具面零审阅工具 | ✅ |

## 环境要求

- [HanaAgent (openhanako)](https://github.com/liliMozi/openhanako) **1.0.0-beta 及以上**（v2 App 体系）
- [PowerContext Server](https://github.com/oceanbase/powercontext) **v1.2.0**（独立安装，本插件不捆绑、不改其配置）
- Python 3.11+ 与 [uv](https://docs.astral.sh/uv/)（Server 侧）
- macOS / Linux（Windows 未验证）

## 安装

### 1. PowerContext Server（一次性）

```bash
uv tool install --force "powercontext[cli,server]==1.2.0"
mkdir powercontext-config && cd powercontext-config
powercontext config init            # 选 Basic memory 即可运行全部核心能力
powercontext server run             # 默认 http://127.0.0.1:8000
```

> full 模式（另配 Generation/Embedding 凭据）解锁完整 Handoff 载体与自动 Topic Memory；Basic memory 已覆盖记忆/召回/边界捕获。

### 2. 本 App

```bash
git clone https://github.com/[owner]/hana-powercontext.git
cd hana-powercontext
```

HanaAgent → 扩展管理 → 从本地目录安装（或从发布 zip 安装）→ 选择 `app/hana-powercontext` → 审核面板确认（预期仅 3 个授权词 + 127.0.0.1 网络块，出现其他条目请拒绝并提 issue）。

> 装完后**在对应 Agent 的设置里启用本 App**——未启用则 `/pc` 命令族对该 Agent 不可见。命令入口是 `/pc`，`/powercontext` 是它的别名。

### 3. 验收三步

```bash
# ① 连通
/pc doctor            # → status: ready
# ② 记忆闭环（让模型记住一件事，然后新开会话问它）
# ③ 推式验证：新会话第一句直接问「之前记住的地址是什么」——不需要模型调用任何工具
```

## 配置（环境变量，四级覆盖链：调用参数 > app-data/config.json > 环境变量 > 默认）

| 键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `prestep` | `POWERCONTEXT_HANA_PRESTEP` | `true` | 推式注入总开关 |
| `prestepMaxBytes` | `…_PRESTEP_MAX_BYTES` | `8192` | 注入正文预算（协议上限 32768） |
| `prestepTimeoutMs` | `…_PRESTEP_TIMEOUT_MS` | `2000` | prepare 超时 |
| `capturePrompts` | `…_CAPTURE_PROMPTS` | `false` | 输入捕获为 Source（写用户 prompt 到 Server，默认关） |
| `captureMaxBytes` | `…_CAPTURE_MAX_BYTES` | `4096` | 单条捕获上限 |
| `beforeStart` | `…_BEFORE_START` | `false` | 会话开始注入最新 Handoff（需 full 模式） |
| `baseUrl` | `POWERCONTEXT_HANA_BASE_URL` | `http://127.0.0.1:8000` | Server 地址（端口被占用时改这里指向别的地址） |

斜杠命令：`/pc doctor`（连通与就绪）· `/pc scope` · `/pc memory` · `/pc handoff` · `/pc hooks`（注入计数与授权台账）· `/pc review`（人工门禁）。完整键表见 [`app/hana-powercontext/README.md`](app/hana-powercontext/README.md)。

## 架构一张图

```
┌─ HanaAgent 宿主 ──────────────────────────────────────────┐
│  聊天会话 ──模型步──> [agent/pre-step 钩子] ──┐             │
│      ↑ 注入有界召回(不可信历史包裹)   │              │             │
│  看板卡 ──后端路由(status/handoff/     │              │             │
│           memory/hooks/prefs) ──┐     │  宿主网络门 (127.0.0.1)      │
│  pc_* 工具 ─────────────────────┤     ↓              ↓             │
│  /pc 命令族 ────────────────────┴──> PowerContext Server (Python) │
└──────────────────────────────────────────────────────────┘
                                         └── 跨 harness：Codex/Claude Code/
                                             DSH 等官方集成共享同一 Server
```

设计不变量：**fail-open**（Server 不可用 → 不注入/工具明确报错，会话照常）；**凭据最小化**（App 从不自设凭据头——有专项断言；入口凭证剥离由宿主路由代理完成，宿主契约见 HanaAgent APPS.md「凭证剥离」节）；**隐私默认关**（prompt 捕获 opt-in）；**引注边界**（召回永远是标注为不可信的数据，永不冒充指令）。

## 已知边界（如实声明）

- **subagent 隔离会话不触发 pre-step**（宿主引擎级边界）：隔离会话的记忆接续走拉式工具；
- **完整 Handoff 载体**（prepare→finalize 的 finalized 输出）需 Server 配置生成 provider（full 模式）；Basic memory 下该工具诚实报 `handoff_generation_unavailable` 并落库边界 Source；
- **smoke 校验**在隔离 AppHost 组合下失败（SDK 入口前置校验，App 代码未执行），真机加载正常——验证以真宿主加载日志为准；
- 召回检索为词项级：完整自然语言长句可能不命中（App 内置 query 提炼层缓解）；
- **full 模式下的 finalize 正路径当前仅有本地模拟证据**（selftest 桩 + `finalize-probe` 模拟生成 provider）；Basic memory 下的诚实能力门与边界 Source 为真机验证；
- **`/pc review approve|reject` 从未对真实候选执行过**（候选需 full 模式产生）；已验证的是门禁的构造保证——模型工具面零审阅工具，且该保证以代码与断言为准。

## 验证体系

本仓库把验收当一等公民：`lib/selftest.mjs`（487 项，含 live 段）/ `lib/dashboard-probe.mjs`（250 项）/ `lib/hook-probe.mjs`（122 项）/ `lib/live-demo.mjs`（真 Server 端到端）/ `scripts/verify-fail-open.sh`（降级语义）。部分验收判据（捕获开启侧 / kill-switch / 真机停机钩子路径）当前仅有离线断言证据，真机执行步骤见 `artifacts/` 验收记录。修复过程全程留痕（`artifacts/` 下验收记录与偏差清单），包括对宿主与上游的可复现缺陷报告。

## 许可

[Apache-2.0](LICENSE)。本项目不含 PowerContext 与 openhanako 的源代码，运行时依赖以独立安装为准，归属见 [NOTICE](NOTICE)。

## 致谢

- [OceanBase PowerContext](https://github.com/oceanbase/powercontext) — 工作上下文系统本体与其官方 DSH 集成（本项目的接口契约参照）；
- [Yang Yizhu / dsh-powercontext](https://github.com/yangyizhu8/dsh-powercontext) — DeepSeek Harness 集成的先行实践；
- [liliMozi/openhanako](https://github.com/liliMozi/openhanako) — HanaAgent 与 v2 App 体系。
