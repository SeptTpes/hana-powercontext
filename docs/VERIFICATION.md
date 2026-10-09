# 验证（Verification）

本 App 自带行为断言体系，全部离线可复跑（live 段除外，需要 Server 在跑）。

| 套件 | 覆盖 | 复跑 |
|---|---|---|
| `lib/selftest.mjs` | 487 项：工具/钩子/prefs/分类与降级逻辑全量 | `node app/hana-powercontext/lib/selftest.mjs` |
| `lib/dashboard-probe.mjs` | 250 项：看板后端路由与视图模型 | `node app/hana-powercontext/lib/dashboard-probe.mjs` |
| `lib/hook-probe.mjs` | 122 项：钩子注册路径与注入行为 | `node app/hana-powercontext/lib/hook-probe.mjs` |
| `lib/live-demo.mjs` | 真 Server 端到端（记忆闭环/交接/降级） | `node app/hana-powercontext/lib/live-demo.mjs` |
| `scripts/verify-fail-open.sh` | Server 不可用时的降级语义 | `scripts/verify-fail-open.sh` |

真机验收三步（安装后）：`/pc doctor` → 记忆闭环 → 推式首问，见 README「安装」节。

运行前提：PowerContext Server v1.2.0（见 README）。
