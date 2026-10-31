# Interaction Bench（ibench）接入

本文记录 best-agent 在 [Interaction Bench](https://github.com/eval-sys/ibench) 上的执行契约。开始前先读根目录 `AGENTS.md`；冻结候选、单次尝试和不覆盖既有 verdict 的规则同样适用。

## 这个 bench 评什么

ibench 用 44 个来自真实开源项目合并 PR 的交互缺陷任务，评测 agent 能否读懂用户意图、在可运行的应用里定位并修好“用户能感觉到”的问题。评分不是跑单测，而是由评分 agent 在打过补丁的应用里重放交互，按专家审阅过的 Require/Allow 条款给出 `repaired` / `not_repaired`。

- 公开榜快照：`GPT-6 Astra (Codex)` 34.1%（15/44）、`Claude Opus 5.5 (Claude Code)` 27.3%（12/44）、`DeepSeek Flash (DSH)` **15.9%（7/44）**、`GLM-5.3 Flash (ZCode)` 9.1%（4/44）。
- 目标基线是 `DeepSeek Flash (DSH)` 的 7/44。官方 solver 配置是 `deepseek-flash/high`、`api.deepseek.com`、DSH `0.2.0-rc.2`；当前 solver 使用 dimagent 的 `deepseek-v4-flash/high`。effort 一致，但模型别名和端点的等价性尚未验证，不能声称只换了 harness。

## 组成（本仓库冻结）

| 维度 | 取值 | 单一事实源 |
| --- | --- | --- |
| 任务集 | 44 题，release `24b0613a`，`tasks/release.json` SHA-256 `e7c351ff…` | `config/ibench.json` |
| 指令 profile | `intent`（默认，仅用户意图） | `config/ibench.json` |
| solver harness | `best-agent-cli 0.0.19` + adapter `0.2.0`，容器内 npm 安装 | `config/ibench/solver-best-agent-deepseek-flash-high.json` |
| solver 模型 | `deepseek-v4-flash`，`reasoningEffort=high`，`dimagent.cn/v1`，`dim-oauth` | `config/ibench.json` |
| scorer（官方） | `codex 0.160.1` + `deepseek/deepseek-flash` + high，`api.deepseek.com` | `config/ibench/scorer-codex-deepseek-official.json` |
| scorer（显式诊断） | `best-agent-cli` + `deepseek-v4-flash` + high | `config/ibench/scorer-best-agent-deepseek-flash-high.json` |
| 分批计划 | 11 批 × 4 题，按 release 顺序完整覆盖 | `config/ibench-batches.json` |

### scorer 的取舍必须写进结果

官方榜单的评分模型是 DeepSeek Flash，通过 `configs/deepseek-flash.json`（Harbor `codex` agent）调用 `api.deepseek.com`。当前 dim 网关凭证被限制为“仅官方客户端可用”，`codex` 无法用它调用；因此：

- 默认固定官方 scorer；没有 `DEEPSEEK_API_KEY` 时，`full` / `score` 在启动模型前失败，不自动换裁判；
- 没有官方 key 时先用 `--solver-only`，冻结补丁并保留完整轨迹；
- 只有显式 `--score-config config/ibench/scorer-best-agent-deepseek-flash-high.json` 才使用 best-agent 诊断评分，并标注不可比。

换 scorer 会改变通过判定。正式比较还需要确认 solver 模型与端点等价；仅换回官方 scorer 并不能消除网关差异。

## solver 如何跑在任务容器里

ibench 把每题编译成 Harbor 任务：solve 阶段的容器里是 `/workspace/app`，solver 必须**把修改提交成 git commit**，任务自带的 verifier 才信任地把 diff 冻结成 `candidate.patch`。

本仓库的 `tools/ibench-agent` 是一个 Harbor 0.23 `BaseInstalledAgent` 插件：

1. `install()`：在容器内用现成的 Node/npm 安装 `@best-agent/cli@<pin>` 到 `$HOME/.ibench-best-agent`，并校验 `--version`。
2. `run()`：上传 `provider.json` 与 `~/.dimcode` 身份文件（`dim-oauth`），以最大权限 profile 启动一次 headless `best-agent run`，产出 `/logs/agent/best-agent-evidence.jsonl`、stdout/stderr 与进程 receipt。
3. solver 阶段结束后由插件执行 `git add -A` + `git commit`（模型自己已提交则跳过），保证 verifier 能采集到 patch。
4. 新接入保留 CLI 的 exit/signal，并把非零结果传给 Harbor。CLI 退出后才做限时 Git 收尾；收尾退出/信号/超时另记，不覆盖主结果。Harbor 的现有失败和可信补丁规则保持原样，失败不会自动重跑。

显式诊断评分可复用同一插件，但 `BEST_AGENT_CLI_WORKSPACE=/workspace`、不提交 git（评分 agent 要写 `case-context` 下的 verdict 与证据）。

## 本地运行

前置：Docker（可跑 linux 任务容器）、`uv`、可用的 dim 登录（`~/.dimcode`）或 `BENCHMARK_PROVIDER_API_KEY`。评分还需 `DEEPSEEK_API_KEY`；官方 `--score-only` 不需要 solver 的 dimagent 凭证。

```bash
# 1) 单题冒烟（推荐先做，约 20-40 分钟，含镜像构建）
node scripts/ibench-run.mjs \
  --tasks photo-map-panning \
  --solver-only \
  --output results/ibench/smoke \
  --n-concurrent 1

# 2) 只跑 solver，冻结 patch，稍后再评分
node scripts/ibench-run.mjs --tasks <id> --solver-only --output results/ibench/<run>

# 3) 全量 44 题（一次性预声明，不重跑、不挑选）
node scripts/ibench-run.mjs --solver-only --output results/ibench/full-<date>

# 4) 汇总分批结果
node scripts/ibench-aggregate.mjs --input results/ibench --output results/ibench/ibench-aggregate.json
```

脚本会：按 `config/ibench.json` 校验 release 和 manifest 哈希 → 准备 `.tmp/ibench-<sha8>` 检出 → `uv sync --frozen`（按发布时的 `uv.lock` 原样安装，不重新解析）→ 安装插件 → 构建 `ibench-dev:<version>` 基础镜像（缺失时）→ 调用 `uv run ibench run` → 把 ibench 自己的 `results.json` 抄写成 `ibench-report.json` / `.md`。凭据只写到 `.tmp/ibench-provider-<runId>/`，运行结束即删除。

国内网络可用 `UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple` 加速 Python 依赖；镜像拉取速度取决于 Docker 网络。

## CI

`.github/workflows/ibench.yml`（ubuntu + Docker，macOS runner 没有 Docker 不能跑这个 bench）：

- `ibench-check`：评分模式先检查官方 key，再验证代码与 release，不把缺凭据的计划扩成付费模型任务。
- `ibench-plan`：从 `config/ibench-batches.json` 生成矩阵；`ibench_tasks` 非空时退化成单 job 诊断，仍受冻结的 4 题上限约束。并发必须是 1–4 的整数。
- `ibench-run`：每个批次一个 job，`timeout-minutes: 350`，跑 `scripts/ibench-run.mjs`，上传该批证据。
- `ibench-aggregate`：下载全部批次报告，校验“同一冻结组成 + 完整覆盖”，写 `ibench-aggregate.json`；不完整时只能加 `--allow-partial`，此时 `partial: true` 且不声明可比。

输入项：`run_ibench`（是否真正发起）、`ibench_mode`（`full` / `solver-only` / `score`）、`ibench_tasks`（逗号分隔的冻结任务 id/name）、`ibench_batches`（跑前 N 批，0 = 全部）、`ibench_concurrency`、`ibench_source_run`（仅 `score` 模式：要重判的那次 run id）。

### solve 与 judge 解耦

被测的是 harness，judge 是固定的测量装置。IBench 把 solver 的补丁冻结在 `jobs/solve`、把编译好的评分任务留在 `compiled/score`，所以 `ibench score --overwrite` 可以只换裁判、不重放任何一次模型尝试：

```bash
# 1) 解一次，冻结 44 份补丁
gh workflow run ibench.yml --ref master -f run_ibench=true -f ibench_mode=solver-only -f ibench_batches=0

# 2) 官方裁判就位后，原地重判（不重跑 solver）
gh workflow run ibench.yml --ref master -f run_ibench=true -f ibench_mode=score \
  -f ibench_source_run=<第 1 步的 run id>
```

`score` 模式会先校验 `DEEPSEEK_API_KEY` 与 `ibench_source_run`，缺一即失败——重判的意义就是用上官方 `codex` + `deepseek-flash` judge，没有它就只会产出一个形似的数字。

重评分前，runner 把原 `run.json`、`results.json`、报告和完整 `jobs/score` 归档到该批的 `prior-scores/<timestamp>/`，新报告引用归档路径。原 solver 身份、模型、指令 profile 与冻结补丁不变。评分进程非零退出会保留源错误和报告并使 CI 失败，不会显示成绿色执行成功。

注意：每题 solve + score 各最多 1 小时，4 题一批在 4 vCPU runner 上可能接近 6 小时 job 上限；正式全量更适合分批多次触发，或换更大的 runner。

## 结果如何读

- `ibench-report.json`：`passRate = passed / total`，`passed` 只统计 `rewards.reward == 1`；未评分/失败题保留在 `tasks[]` 里，不重试。
- `comparableToPublishedLeaderboard`：必须完整 44 题、非 solver-only、官方 scorer，且 solver 的模型 ID、端点、effort 与冻结基线一致。当前 dimagent 配置保持 `false`，不推断模型别名等价。
- 子集、solver-only、回退 scorer 的结果一律是诊断读数，不得写成对 DSH 7/44 的正式对比。

## 与官方 harness 的已知差异

- **补提交**：官方 DSH / Codex 依赖 agent 自己 `git commit`；本插件在 solver 返回后再补一次 `git add -A` + commit（模型已提交则跳过），避免“修好了但没提交”被记成空 patch。这条对 solver 略宽松，比较时应披露。
- **scorer**：历史运行使用过 best-agent 诊断 scorer；新运行默认固定官方 codex scorer，没有 key 时先 solver-only。
- **CLI 安装**：每个任务容器单独 `npm install` 一次（容器是一次性的），没有做镜像级预热。CI 实测每题每阶段 8–10 秒（`agent_setup` 7.5–9.1 s），一批 4 题共两次阶段约 72 秒，占 b01 全程 98.6 分钟的 1.2%；本地慢网络下才是分钟级。

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

### 本地 macOS 的限制（不是 bench 的限制）

ibench 的任务把 solve 步骤固定在 `network_mode = "allowlist"`，Harbor 0.23 为此启动 `gost` egress sidecar，其 nftables 规则只放行 TCP 转发（除 `/etc/resolv.conf` 列出的解析器外拒绝其余 UDP）。在 Docker Desktop 上这套配置下 DNS 查询返回 SERVFAIL（同一个 sidecar 切回 `public` 立刻恢复），模型端点因此无法解析：

```
v3 run model-failure: connection: Cannot connect to API: getaddrinfo EAI_AGAIN dimagent.cn
```

这条只属于 Docker Desktop，Linux 上不复现（见下）。本机的容器级冒烟因此改用 `public` 网络，真实运行一律放 CI。

### 首次容器端到端读数（CI 诊断，2026-10-31）

run [41151844978](https://github.com/Simon-He95/best-agent-benchmarks/actions/runs/41151844978) 的 batch `b01`，4 题，链路全绿：容器内安装 CLI → allowlist 下模型可达 → solve 冻结 `candidate.patch` → 独立 score 容器重放交互 → 写出 verdict 与 issue 级理由。四个 job（校验、计划、b01、聚合）均 `success`。

| 任务 | solve | 补丁改了哪里 | score | 判定 |
| --- | --- | --- | --- | --- |
| `Afilmory#243` photo-map-panning | 21.2 min，CLI `exitCode 1` | `main.tsx` + 两个调试用 `module-probe.html` | protocol 1 / repair 0 | 平移地图后详情卡仍未跟随标记移动 |
| `Afilmory#274` tiny-storage-comparison | 18.0 min | 后端 `cleanup-candidates.service.ts` 的 storage 聚合 SQL | protocol 1 / repair 0 | Content 列仍按 `toFixed(1)` 显示 `0.0 MB`，小体积与空工作区不可区分 |
| `actual#7827` csv-footer-skipping | 54.3 min | `ImportTransactionsModal.tsx` 把解析失败从 `break` 改成 `continue` | protocol 1 / repair 0 | 改的是“坏行不再中止”，而 bug 是改 Skip end lines 后字段映射被重置 |
| `cal.diy#29544` password-form-editing | 43.0 min | `password-view.tsx` 加 `autoComplete` | protocol 1 / repair 0 | 三个非法状态下 Update 仍可点，补的是浏览器自动填充提示 |

读数 `0/4`，`partial: true`，`comparableToPublishedLeaderboard: false`（4 题子集 + 回退 scorer）。这是诊断，不是对 DSH 7/44 的对比。产物 `ibench-41151844978-b01`，76,080,241 B，SHA-256 `d477b31b…`。

三条与本地不同的事实：

1. **allow-list 在 Linux 上不阻塞 DNS。** 整份产物里 0 处 `getaddrinfo`/`EAI_AGAIN`；四题 solve 的 verifier 均 `reward 1`，四个 score agent 也都在同一 allowlist 下正常出 verdict。上面那条 macOS 症状不适用于 CI。
2. **一题的 solver 被上下文打满。** `Afilmory#243` 在 21 分钟处以 `context_length_exceeded`（HTTP 400，`invalid_request_error`）退出，CLI `exitCode 1`；它的补丁是崩溃后按工作区最终状态冻结的（HEAD `3fc2309` → `763357e`），因而带着模型调试用的两个 `module-probe.html`。判定不变（本来也没修好），但长轨迹会把窗口吃满。
3. **预算语义更正。** `actual#7827` 用了 54.3 分钟。`BEST_AGENT_RUN_DURATION_MS=3300000` 是会随进展续期的无进展租约，不是 55 分钟尝试预算；旧接入没有据此留出 5 分钟收尾时间。旧运行参数和 verdict 保留，新接入使用实际 Harbor 尝试预算。

**仍未验证**：全量 44 题，以及官方 `codex` + `deepseek-flash` scorer（缺 `DEEPSEEK_API_KEY` 时一律走回退 scorer）。

## CI 修正与本次预声明（2026-10-31）

上面的回退行为属于历史实现；当前默认固定官方裁判。此次只改外部 benchmark CI/报告，不改 best-agent 产品、Harbor agent 插件或发布候选。

审查先于实现，按 `harness-v3-reviewer`、Platform/Evaluation 协议对照 Kernel、Extension、Operational 和 Capability boundary/admission 合同：

- `[BUG/P1]` 原 runner 缺官方 key 时自动选择另一 harness 评分。可达路径是 `full → pickScorer → best-agent scorer`；修正为模型启动前报缺少的 key，或显式选择 solver-only。依据是固定测量配置与 Evaluation §2 的 criteria/report 外部 owner 边界。
- `[BUG/P1]` 原 `scoreExistingRun` 无条件读取 solver 凭据，并从当前 profile 重建旧 solver 身份；`--overwrite` 还会删除原 score job。现在官方评分只使用官方 key，从原报告保留身份，并在覆盖前归档原结果和完整 score 轨迹。依据是 Operational §§6.1、8.1 的来源保真与单向投影，以及根 `AGENTS.md` 的保留 verdict 规则。
- `[BUG/P2]` 原 CI 自选任务分支不检查批次上限。现在它和冻结批次使用相同的 4 题上限，拒绝不合法并发。
- `[BUG/P1]` 原通过率报告仅凭全量与官方裁判就声明可比。现在还核对冻结基线的模型 ID、端点、effort，不把未证实的 dimagent 别名当成官方同模型。

实现分类为 Conformance，能力归属是 Application/external benchmark process。CI 拥有批次与外部进程；IBench 拥有冻结补丁和 canonical rewards；报告只抄写，不改变 verdict，也不启动下一次 solver。贡献 kind/cardinality、Harness owner/writer、identity、RuntimeState、KernelInput/Directive、cursor、RunEvent、lifecycle 全部无变化；Gate A/B/C 均不适用。相关技能仅提供执行协议，不提供架构或运行权限。

错误/控制流验收：实际 Node runner 经受控 `uv` 进程 fixture 执行官方 `score` 一次，solver 调用 0 次，插件安装 0 次；缺 key 时评分调用也是 0 次。成功返回 exit 0；受控源错误 `controlled score source failure` 返回 exit 7，stderr、结果中的 error 和 exit code 均保留到 runner 终态，CI 不再吞掉失败。fixture 还逐字节核对旧报告、旧 results、旧 score 错误文件与冻结 solver patch，确认新报告保留原 solver/model/profile。这里没有改动或运行 Kernel 的 model/tool 调用路径，故不伪造 next-model/sibling 证据，也不将 fixture 当作真实容器任务通过证据。官方评分的真实容器执行仍等待 key。

验证命令与结果：

| 命令/检查 | 结果 |
| --- | --- |
| `node --test test/ibench.test.mjs` | exit 0，16 项；包括实际 CI 内联矩阵脚本及 runner 子进程正反例 |
| `<pinned ibench venv>/bin/python test/ibench-agent.test.py` | exit 0，4 项 |
| `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 -shellcheck= .github/workflows/ibench.yml` | exit 0；未运行 shellcheck |
| 真实 IBench `configure_job` 加载 solver 与无 key 的延后官方 scorer | exit 0；1 次 solver attempt、0 retries，官方 scorer 端点 allowlist 正确 |
| `node scripts/ibench-run.mjs --dry-run --solver-only --tasks <本次四题> --ibench-source <pinned checkout>` | exit 0；release SHA 与 manifest SHA-256 匹配 |
| `git diff --check` | exit 0 |
| `npm test` | exit 1；两个 SWE-bench candidate closure 断言失败，未声明全绿或合并通过 |

全仓测试所需的忽略数据已从本机原 checkout 复制，并核对 corpus `f61cd55c…`、ledger `a4a87551…`。剩余失败为 `formal admission exact-covers 500 task receipts and rejects a mutated artifact` 和 `public benchmark artifacts match the pinned candidate record`：候选记录期望 closure `6a1455a5…`，当前为 `99c82478…`。逐个读取基线 `f838a0a` 的全部 closure 文件计算，得到相同的 `99c82478…`，且本次未改这些文件。这只解释阻塞，不豁免 pass-only merge gate；本分支尚不满足合并条件，没有请求或执行合并。

Harness benefit record：基线/候选使用同一冻结配置及输入。基线默认可换裁判、5 题自选任务可绕过批次上限、重评分需要 solver 凭据；候选的矩阵测试拒绝 5 题，实际评分 caller 仅需官方 key，且对同一历史报告保留来源和错误。收益是用户要求的可审计对比流程与避免无效评分任务；代价是缺 key 的评分显式失败、保留旧 score 轨迹增加存储、未验证别名等价时不声明严格可比。未测量也不声称任务成功率提升、避免的 ToolCall 失败数量、推理效率或 billed-token 节省。

旧全量运行 [41162502705](https://github.com/Simon-He95/best-agent-benchmarks/actions/runs/41162502705) 有 10 批、40 题产物；b05 在 `2026-10-31T03:21:27Z` 收到 runner shutdown，exit 143，未上传该批产物。模型已开始，因此不是 pre-model recovery。本次用户明确选择现有 dimagent 凭据的 solver-only；预声明见 `config/ibench-solver-only-b05-20261031.json`：只对 b05 四题各增加一次诊断尝试，候选、模型、effort、任务预算保持冻结值，评分延后。旧运行与 verdict 均保留，不把本次与旧 40 题拼成严格 pass@1，不把诊断运行声明为 DSH 7/44 的正式比较。

调度收据：[41197692944](https://github.com/Simon-He95/best-agent-benchmarks/actions/runs/41197692944)，`2026-10-31T11:38:30Z`，冻结 wrapper commit `a933456e373425a2d8537e879b47508000f4b63b`，分支 `codex/ibench-ci-comparison`。输入为预声明的四个 task ID、`run_ibench=true`、`ibench_mode=solver-only`、`ibench_concurrency=2`；仅触发一次，没有取消或重启旧运行。任务结果待运行完成；没有据队列状态推断任务通过。


## Adapter 0.2.0：真实预算与初始环境

本次用户只授权 P0/P1 和自有小任务验证；没有启动或重跑公开 benchmark，也不改 exec/process 上限、coding 指令、官方任务或评分器。CLI 仍冻结在 `0.0.19`，solver label 增加 `ibench-adapter 0.2.0`，避免与旧接入混合汇总。

预算来自 Harbor 0.23 的实际单阶段 task/trial 配置，按框架同一规则计入 step timeout、override、maximum 和 timeout multiplier。`agent.run` 入口启动单调时钟，CLI 前扣除准备耗时及固定 30 秒接入层收尾余量，再传 `--attempt-remaining-ms`。CLI 自己保留的 30 秒停止结算和 30 秒清理不变；单次模型 ceiling 与 Run 租约独立。`best-agent-attempt-timing.json` 保留预算、准备耗时、收尾余量和传入值。它是保守投影，不保证消除进程崩溃或所有外层强杀。

容器驱动只启动一次 CLI；CLI 退出后先落盘 `best-agent-process-receipt.json`，再做最多 30 秒的 Git 收尾。收尾超时终止并等待自己启动的进程组。CLI exit/signal 与 `finalizationExitCode`、`finalizationSignal`、`finalizationTimedOut` 分别保存，stdout/stderr 也分别保留。实际非零结果传播至 Harbor；没有交付模型、自动续跑、边运行边提交或合成 footer。按既有 IBench admission，含此异常的 solver trial 不进入评分，即使保留了非空补丁；本次收尾不提供失败救分路径。IBench 原有 collect hook 仍是唯一 canonical patch producer，空补丁和失败不会被修饰为成功。

solver 的环境说明在模型前形成一次：只选 `DEV_ENV_SETUP`、`DEV_ENV_START`、`DEV_ENV_READY`，执行一次限时 readiness probe，观察本容器的 loopback HTTP listener/status 和 `agent-browser` 路径/版本。最多探测 8 个监听端口，若超出会明确标注，非 HTTP TCP 监听不会被当成网页。记录和初始说明均不超过 65,536 UTF-8 字节。`best-agent-environment.json` 保存原观察、确切追加文本及 SHA-256；原始公开 task instruction 原样保留，环境块只追加一次。准备失败在模型前返回并保留 source output。

这份说明只证明初始观察；`sourceRefresh: unverified` 明示源码修改是否已加载尚未验证。它不读取 provider 凭据、任意环境变量、score task、rubric、参考补丁或历史诊断；不刷新 active Run，不增加另一份 coding checklist。官方 codex scorer 不走这个插件。

本地自有验证入口（受控 HTTP 模型，不请求真实模型）：

```bash
# Linux 自有容器；验证固定发布产物支持 budget 参数
docker build -t best-agent-ibench-closure:0.0.19 test/fixtures/ibench-closure
# 使用 harbor==0.23.0 的 Python
<ibench-venv>/bin/python test/ibench-agent.test.py
uv build --wheel tools/ibench-agent --out-dir results/ibench/adapter-wheel
<ibench-venv>/bin/python test/ibench-agent.e2e.py --wheel results/ibench/adapter-wheel/ibench_best_agent-0.2.0-py3-none-any.whl --output results/ibench/self-owned-<unique-id>
```

测试涵盖正常完成、写入后预算停止、未写入即停止、长工具执行中的停止、provider 503、Git 提交失败、readiness 失败/超时，以及旧 caller 在同一自有任务上的外层超时对照。它们只能证明受控调用链、产物与错误保真，不能作为 iBench 通过率或真实模型服从性的证据。

### P0/P1 验收记录

实际验证是本机 OrbStack 的 Linux amd64 容器（arm64 宿主上的仿真），Node 24.15.0、发布 CLI 0.0.19、Harbor 0.23.0。固定 wheel SHA-256 为 `9d0a240c67d8e2ed48ff32eeac70c9a5408a738e6dbabf97e31a55e1117aa07c`；解包的两个执行模块与当前源码逐字节一致。镜像 ID 为 `sha256:0df140605072d6b92d6d43445854d8c3731be64bae51cd9463ed8141f64538bb`。模型是容器 loopback 上的确定性 HTTP fixture，不调用 DeepSeek 或其它付费模型。正常安装路径仍执行，依赖缓存只用于让自有测试离线安装；`agent-browser` 在这个自有镜像中缺席，环境记录如实为 null，未据此宣称浏览器会话可用。

| 自有场景 | model POST 数 | Run / CLI | Git 收尾 | frozen patch / footer |
| --- | ---: | --- | --- | --- |
| completed | 3 | completed/completed，exit 0 | exit 0 | 171 B / complete |
| budget-work | 3 | cancelled/stopped，exit 1 | exit 0 | 171 B / complete |
| budget-empty | 1 | cancelled/stopped，exit 1 | exit 0 | 0 B / complete |
| budget-tool | 2 | cancelled/stopped，exit 1 | exit 0 | 171 B / complete |
| provider-failure | 1 | failed/model-failure，exit 1 | exit 0 | 0 B / complete |
| commit-failure | 3 | completed/completed，CLI exit 0 | exit 128，真实 index.lock 错误 | 0 B / complete；Harbor 失败 |
| readiness-failure / timeout | 各 0 | 尚未创建 Run/CLI | 不执行 | 不伪造 footer/receipt |
| baseline-work（74e8c4c） | 3 | Harbor AgentTimeoutError，agent phase 100.007 s | 未到达 | 0 B / 无 footer、receipt |

长工具用例实际一次 exec 被停止，source 观察完整保留为 `unknown/uncertain`，含 `SIGKILL`、`exitCode=null`、`terminationRequest=AbortSignal received`；同批后续 write 得到唯一 `not-invoked/stopped`，零进入、无 sentinel 文件，且没有下一 model 请求。写入后等待用例保留 terminal 后到达的 abort model-failure 行；这不改写 `cancelled/stopped`，也不被归因成 provider 导致的终态。provider 用例只请求一次，原 `owned-provider-fault`、HTTP 503 和响应正文在 stderr 保留。提交失败不会把已完成 Run 改成 failed；CLI receipt 先落盘，外部 Git 错误和 Harbor 失败独立保留。

readiness 非零保留实际 exit 7 和原 stderr，超时保留实际 SIGKILL、空 exitCode、timedOut 与源日志；两者模型入口均为零。另一个 POSIX 原生进程组用例实测 30 秒 Git 收尾 cutoff、保留 CLI exit 0、finalization signal SIGKILL/timeout 和 driver exit 124，并在额外等待后确认孙进程没有继续写文件。它是受控故障，不是公开任务数据。

每份 complete evidence 均核对连续 sequence、expected/written counts 和 prefix SHA-256。旧/新自有 work 对照的实际首个 SDK 请求，其 tool definitions 和 system messages 完全一致；没有借本次改动修改 coding 或 exec 定义。实际初始说明为 855 UTF-8 字节，模型请求中恰好出现一次；记录/text 哈希一致，不含 provider key 或配置路径，且始终保留 `sourceRefresh: unverified`。这是来源与注入证据，不是模型服从性或任务质量证据。

可复核本地数据：`results/ibench/p0-p1-acceptance.json`；正常完成原件 `results/ibench/p0-p1-self-check-4/`；其它八个场景及旧 caller 对照 `results/ibench/p0-p1-self-cases/`。这些被 Git 忽略的本地证据保留原始 trial、请求、footer、receipt 和补丁，不替换任何既有 benchmark verdict。

命令和结果：`<pinned venv>/bin/python test/ibench-agent.test.py` exit 0（9 项，含原生收尾超时）；`node --test test/ibench.test.mjs` exit 0（16 项）；自有 E2E 两条命令分别以 `--cases completed` 和 `--cases budget-work,budget-empty,budget-tool,provider-failure,commit-failure,readiness-failure,readiness-timeout,baseline-work` 运行，均 exit 0；ruff check/format-check、actionlint（未启用 shellcheck）、`git diff --check` 均 exit 0。`npm test` exit 1，271/273，仍为上文两个旧 SWE candidate closure 断言，未接受例外或执行合并。产品仓库只改合同/实现记录：build、lint、check:docs、构建后的 check:packages、format:check 均 exit 0；没有改运行时代码。

准备期间的失败另留档、没有计入验证通过：首次 arm64 镜像下载遇到 npm ECONNRESET；`run --help` 不受该 CLI 支持，改用明确拒绝 60000 ms 的无模型 admission 探针；首次离线安装缺缓存后将安装缓存保存到自有镜像；Docker 到宿主 HTTP 的 fake-IP 路径分别由 Python/Node 复现连接重置，故只将测试模型改为容器 loopback，生产 provider 路由没有变。早期 fixture 对缺失 step 的 TypeError 已改为先断言真实 preparation exception。原失败目录 `self-check-1/2/3` 保留。没有绕过运行时错误来制造绿色结果。

Harness benefit record：相同 CLI、镜像、100 秒外层预算、公开自有任务和三次固定模型请求，旧 caller 在 cutoff 时丢失补丁及闭合证据，新 caller 保留 171 B 补丁和完整闭合，同时仍报告 stopped/exit 1。该对照验证产物保留和诚实停止，不证明任务更快完成，也不把自有 verifier reward 当公开 bench 成功。P1 验证了正确初始事实的一次交付和失败准备的零模型入口；没有测得真实模型少调查多少轮或少失败多少 ToolCall。代价是 90 秒总收尾预留（CLI 60 秒加 wrapper 30 秒）、准备探测耗时和初始输入增加 855 字节；实际 token 用量及 billed cost 未测量，不声称节省。后续真实模型/benchmark 效果仍需另行授权，当前没有 dispatch、重跑、重评分或 npm 发布。另以只读方式检查了冻结 release 的 44 个 solve task 定义：均为一个 3600 秒 agent step，且提供 DEV_ENV_READY；这是静态兼容性检查，未启动这些任务的容器或模型。

## P1：短同步命令与长验证（2026-10-31，后续授权）

用户随后明确授权修改 exec/process 分工与唯一 coding 指令。solver profile 通过既有 `--workspace-process-duration-ms 120000` 选择两分钟同步上限，solver label 同步记录 `exec<=120000ms`。长时间或时长不确定的验证应由模型选择独立的 `process-start/read/stop`；没有自动重路由、重试或隐藏超时。CLI 仍固定 0.0.19，因此本仓库的配置立即表达上限，但产品仓库新 coding 2.24 指令必须等待未来发布并显式升级 CLI 后才生效；本次没有发布 npm 或更换 CLI。

自有 E2E 不再复制执行参数，而是读取实际 solver JSON，并检查真实 SDK 请求里 exec 的全部 `lifetimeMs.maximum` 均为 120000。使用同一 0.2.0 wheel/发布 CLI 的 `completed,budget-tool` 两题已运行，exit 0；分别 3/2 次模型请求、Run completed/stopped、CLI exit 0/1，均保留 171 B 补丁、完整 footer 和 exit 0 的独立 Git 收尾。停止用例仍保留 `unknown/uncertain` 原始 SIGKILL 观察，后续 write 唯一 `not-invoked/stopped` 且未执行；没有后续模型请求。原始证据在 `results/ibench/exec-lanes-config-exact/`，不是公开 benchmark 或真实模型通过率证据。

为满足全仓 pass-only 检查，另外校正 `config/best-agent-candidate.json` 已失配的 `controlClosureSha256` 为实际 closure `99c8247884e7899261eb0f07e7f6a15ef5f22ddabdfde50d6f4688047247166d`。这是上文两个失败的修正；不更换执行产物、语料、历史结果或评分，`formalBenchmarkReady` 仍为 false。修正后 `npm test` exit 0，273/273；不能将这些测试数量解释成任务成功率。

本次收益是冻结配置确实限制同步阻塞时间，且原有真实预算/失败来源/补丁收尾仍可达。合法长验证需要额外 process 观察调用；是否提高真实任务完成率或降低 billed tokens 尚未测得。旧、新各次本地失败和历史 benchmark verdict 均保留，没有 dispatch、重跑或重评分公开任务。
