# Interaction Bench（ibench）接入

本文记录 best-agent 在 [Interaction Bench](https://github.com/eval-sys/ibench) 上的执行契约。开始前先读根目录 `AGENTS.md`；冻结候选、单次尝试和不覆盖既有 verdict 的规则同样适用。

## 这个 bench 评什么

ibench 用 44 个来自真实开源项目合并 PR 的交互缺陷任务，评测 agent 能否读懂用户意图、在可运行的应用里定位并修好“用户能感觉到”的问题。评分不是跑单测，而是由评分 agent 在打过补丁的应用里重放交互，按专家审阅过的 Require/Allow 条款给出 `repaired` / `not_repaired`。

- 公开榜快照：`GPT-6 Astra (Codex)` 34.1%（15/44）、`Claude Opus 5.5 (Claude Code)` 27.3%（12/44）、`DeepSeek Flash (DSH)` **15.9%（7/44）**、`GLM-5.3 Flash (ZCode)` 9.1%（4/44）。
- 我们要对比的基线就是 `DeepSeek Flash (DSH)` 的 7/44：同样的模型、同样的 `reasoning effort = high`，只换 harness。

## 组成（本仓库冻结）

| 维度 | 取值 | 单一事实源 |
| --- | --- | --- |
| 任务集 | 44 题，release `24b0613a`，`tasks/release.json` SHA-256 `e7c351ff…` | `config/ibench.json` |
| 指令 profile | `intent`（默认，仅用户意图） | `config/ibench.json` |
| solver harness | `best-agent-cli 0.0.19`，容器内 npm 安装 | `config/ibench/solver-best-agent-deepseek-flash-high.json` |
| solver 模型 | `deepseek-v4-flash`，`reasoningEffort=high`，`dimagent.cn/v1`，`dim-oauth` | `config/ibench.json` |
| scorer（官方） | `codex 0.160.1` + `deepseek/deepseek-flash` + high，`api.deepseek.com` | `config/ibench/scorer-codex-deepseek-official.json` |
| scorer（回退） | `best-agent-cli` + `deepseek-v4-flash` + high | `config/ibench/scorer-best-agent-deepseek-flash-high.json` |
| 分批计划 | 11 批 × 4 题，按 release 顺序完整覆盖 | `config/ibench-batches.json` |

### scorer 的取舍必须写进结果

官方榜单的评分模型是 DeepSeek Flash，通过 `configs/deepseek-flash.json`（Harbor `codex` agent）调用 `api.deepseek.com`。当前 dim 网关凭证被限制为“仅官方客户端可用”，`codex` 无法用它调用；因此：

- 有 `DEEPSEEK_API_KEY` 时，`scripts/ibench-run.mjs` 自动选官方 scorer；
- 没有时退回 best-agent CLI 作为评分 agent，并在报告里写 `scorerIsOfficial: false`、`comparableToPublishedLeaderboard: false`。

回退 scorer 改变的是“谁来判断修复是否达标”，不改变 solver 的通过上限；但为了让数字能和 DSH 的 7/44 并列，正式对比应使用官方 scorer。

## solver 如何跑在任务容器里

ibench 把每题编译成 Harbor 任务：solve 阶段的容器里是 `/workspace/app`，solver 必须**把修改提交成 git commit**，任务自带的 verifier 才信任地把 diff 冻结成 `candidate.patch`。

本仓库的 `tools/ibench-agent` 是一个 Harbor 0.23 `BaseInstalledAgent` 插件：

1. `install()`：在容器内用现成的 Node/npm 安装 `@best-agent/cli@<pin>` 到 `$HOME/.ibench-best-agent`，并校验 `--version`。
2. `run()`：上传 `provider.json` 与 `~/.dimcode` 身份文件（`dim-oauth`），以最大权限 profile 启动一次 headless `best-agent run`，产出 `/logs/agent/best-agent-evidence.jsonl`、stdout/stderr 与进程 receipt。
3. solver 阶段结束后由插件执行 `git add -A` + `git commit`（模型自己已提交则跳过），保证 verifier 能采集到 patch。
4. 非零退出码被记录而不是抛出：ibench 只按“是否有可信 patch + 评分 verdict”判定，一次失败的 CLI 调用不该被误当成基础设施错误重跑。

评分阶段复用同一插件，但 `BEST_AGENT_CLI_WORKSPACE=/workspace`、不提交 git（评分 agent 要写 `case-context` 下的 verdict 与证据）。

## 本地运行

前置：Docker（可跑 linux 任务容器）、`uv`、可用的 dim 登录（`~/.dimcode`）或 `BENCHMARK_PROVIDER_API_KEY`。

```bash
# 1) 单题冒烟（推荐先做，约 20-40 分钟，含镜像构建）
node scripts/ibench-run.mjs \
  --tasks photo-map-panning \
  --output results/ibench/smoke \
  --n-concurrent 1

# 2) 只跑 solver，冻结 patch，稍后再评分
node scripts/ibench-run.mjs --tasks <id> --solver-only --output results/ibench/<run>

# 3) 全量 44 题（一次性预声明，不重跑、不挑选）
node scripts/ibench-run.mjs --output results/ibench/full-<date>

# 4) 汇总分批结果
node scripts/ibench-aggregate.mjs --input results/ibench --output results/ibench/ibench-aggregate.json
```

脚本会：按 `config/ibench.json` 校验 release 和 manifest 哈希 → 准备 `.tmp/ibench-<sha8>` 检出 → `uv sync --frozen`（按发布时的 `uv.lock` 原样安装，不重新解析）→ 安装插件 → 构建 `ibench-dev:<version>` 基础镜像（缺失时）→ 调用 `uv run ibench run` → 把 ibench 自己的 `results.json` 抄写成 `ibench-report.json` / `.md`。凭据只写到 `.tmp/ibench-provider-<runId>/`，运行结束即删除。

国内网络可用 `UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple` 加速 Python 依赖；镜像拉取速度取决于 Docker 网络。

## CI

`.github/workflows/ibench.yml`（ubuntu + Docker，macOS runner 没有 Docker 不能跑这个 bench）：

- `ibench-plan`：从 `config/ibench-batches.json` 生成矩阵；`ibench_tasks` 非空时退化成单 job 诊断。
- `ibench-run`：每个批次一个 job，`timeout-minutes: 350`，跑 `scripts/ibench-run.mjs`，上传该批证据。
- `ibench-aggregate`：下载全部批次报告，校验“同一冻结组成 + 完整覆盖”，写 `ibench-aggregate.json`；不完整时只能加 `--allow-partial`，此时 `partial: true` 且不声明可比。

输入项：`run_ibench`（是否真正发起）、`ibench_mode`（`full` / `solver-only`）、`ibench_tasks`（逗号分隔的冻结任务 id/name）、`ibench_batches`（跑前 N 批，0 = 全部）、`ibench_concurrency`。

注意：每题 solve + score 各最多 1 小时，4 题一批在 4 vCPU runner 上可能接近 6 小时 job 上限；正式全量更适合分批多次触发，或换更大的 runner。

## 结果如何读

- `ibench-report.json`：`passRate = passed / total`，`passed` 只统计 `rewards.reward == 1`；未评分/失败题保留在 `tasks[]` 里，不重试。
- `comparableToPublishedLeaderboard`：只有“完整 44 题 + 非 solver-only + 官方 scorer”才为 `true`。
- 子集、solver-only、回退 scorer 的结果一律是诊断读数，不得写成对 DSH 7/44 的正式对比。

## 与官方 harness 的已知差异

- **补提交**：官方 DSH / Codex 依赖 agent 自己 `git commit`；本插件在 solver 返回后再补一次 `git add -A` + commit（模型已提交则跳过），避免“修好了但没提交”被记成空 patch。这条对 solver 略宽松，比较时应披露。
- **scorer**：见上文，默认可能不是官方 codex scorer。
- **CLI 安装**：每个任务容器单独 `npm install` 一次（容器是一次性的），每题多约 1–2 分钟；没有做镜像级预热。

## 验证状态（2026-10-30）

已在本机跑通的检查：

| 检查 | 结果 |
| --- | --- |
| `ibench check .`（release 完整性，44 题） | `Checked 44 task(s) in lobehub/ibench@0.1.0.` |
| `harbor==0.23.0` 加载两份 JobConfig 并实例化插件 | `BestAgentCli` / `best-agent-cli`，solver → `/workspace/app`，scorer → `/workspace` |
| `test/ibench-agent.test.py`（4 项，假环境校验插件 shell） | OK |
| `node --test test/ibench.test.mjs`（11 项，选题/报告/聚合合同） | OK |
| 任务编译（`photo-map-panning`，intent prompt） | 产出 `task.toml` + 指向 `/workspace/app`、要求提交的 instruction |
| CLI 参数与提交链路冒烟（宿主同版本 CLI + dim 身份） | 模型改好 `calc.py`、自测并提交 `dcfaa75`，evidence 49KB |
| 容器端到端（本地 Harbor smoke task，`local-node:24`） | 容器内安装 `@best-agent/cli@0.0.19` → 模型改好 `calc.js` 并自提交 `50b447a` → verifier `reward 1`，evidence 422KB |

冒烟用的任务与 JobConfig 在 `.tmp/harbor-smoke/`（`.tmp/` 已被 `.gitignore` 忽略）：`task/` 保持与 ibench 相同的 `allowlist`，`task-public/` 只把 solve 步骤改成 `public`，上面那行 reward 1 来自 `task-public/`。复现命令：

```bash
cd .tmp/harbor-smoke
BEST_AGENT_PROVIDER_CONFIG=$PWD/provider/provider.json \
DIMCODE_HOME=$PWD/provider/dimcode-home \
../ibench/.venv/bin/harbor run -c solver.json -c tasks-public.json --job-name smoke4 -o jobs
```

**未完成**：真实 ibench 任务（`ibench-dev` 镜像 + solve 步骤的 allowlist 网络 + verifier 采集 `candidate.patch` + score agent 出 verdict）。

阻塞点不在插件，而在 macOS 上的 allowlist 网络：ibench 的任务把 solve 步骤固定在 `network_mode = "allowlist"`，Harbor 0.23 为此启动 `gost` egress sidecar，其 nftables 规则只放行 TCP 转发（除 `/etc/resolv.conf` 列出的解析器外拒绝其余 UDP）。在 Docker Desktop 上这套配置下 DNS 查询返回 SERVFAIL（同一个 sidecar 切回 `public` 立刻恢复），于是模型端点解析失败：

```
v3 run model-failure: connection: Cannot connect to API: getaddrinfo EAI_AGAIN dimagent.cn
```

本机没有 Linux Docker，无法确认 Linux 上是否同样复现；预期不会，因为那里的嵌入式 DNS 由 dockerd 在宿主侧转发，不受容器内 nftables 影响，但这条只是推断，未被实测。第一次真实运行放在 CI（GitHub ubuntu runner）上发起，先 `ibench_batches=1`（4 题）确认 allowlist 下模型可达 → solve 产出 `candidate.patch` → verifier 采集 → score agent 写出 verdict，通过后再 `ibench_batches=0` 跑全量。
