# Benchmark 操作手册

本文是运行者入口。开始任何 benchmark 前先读仓库根目录的 `AGENTS.md`；其中的冻结候选、单次尝试、评测隔离和恢复规则优先于本文。

## 当前能力边界

| 流程 | 候选形式 | 当前用途 | 正式全量是否就绪 |
| --- | --- | --- | --- |
| Terminal-Bench 4.0 | CI 从精确 best-agent commit 构建 Linux x64 SEA，冻结 runtime closure 和 Node binary | 63 个 Docker-eligible 任务 | 是，使用 `.github/workflows/terminal-bench.yml` |
| SWE-bench `bench.yml` | `config/best-agent-candidate.json` 指向的已发布 npm/SEA 候选 | 原有 macOS generation + 官方 Docker evaluator | 仅当候选清单自身通过 formal admission；它不是下面的 fixed-Node+CJS 流程 |
| SWE-bench fixed Node + CJS | 私有 Release 中的 `best-agent.cjs` + 固定 Node 24.15.0 | 已冻结失败题的诊断批次 | 否；`diagnosticOnly=true`、`passAt1=null`，没有可用于新源码的通用 500 题 workflow |
| 其他 benchmark | 尚未统一 | 需要按本文末尾的接入合同实现 | 否，除非已有自己的冻结配置、一次性 generation 和官方 evaluator |

不要把“由 Node 构建的 SEA”和“`node best-agent.cjs`”称为同一个候选。候选身份由实际运行字节和 receipt 决定，不由源码分支名决定。

## 不可变规则

1. 先固定候选、模型、effort、corpus、任务列表、权限和时限，再发起任何模型调用。
2. 正式 pass@1 必须是一份候选覆盖完整冻结任务集，每题恰好一次预声明模型尝试。subset、失败题重跑、跨 run 拼接只能标为 diagnostic，`passAt1` 必须是 `null`。
3. 模型开始前不得暴露 reference/gold patch、`test_patch`、FAIL_TO_PASS、PASS_TO_PASS、官方命令、verifier verdict/log 或历史任务提示。
4. patch 和完整 trajectory 在 evaluator 前冻结并哈希。只有 benchmark 指定的官方 evaluator 可以给 canonical verdict。
5. 不得根据 evaluator 结果重试、换 patch、best-of-N 或覆盖已有 prediction。CI 的“Re-run failed jobs”同样可能制造第二次模型尝试，不可直接点击。
6. 无 prediction 的恢复只允许用于机械证明的模型前环境失败或显式 provider transport failure；必须先冻结 recovery manifest，保留原失败证据，并使用相同候选和同一 formal run 语义。

## 最大权限的准确含义

best-agent 在任务隔离边界内使用以下最大执行 profile：

```text
workspaceBackend=plain
workspaceAuthorization=unrestricted
processIsolation=host
commandPolicy=path
workspaceGrants=read,write,exec
maxModelCycles=2251799813685247
workspaceProcessDurationMs=2147000000
network ToolBinding=excluded
```

`host` 指任务容器内的进程面，不是 GitHub runner 或开发机宿主。模型不得获得 controller 文件、Docker socket、grader、其他任务或宿主目录。禁止 network ToolBinding 也不等于 shell 无网络：

- Terminal-Bench 任务容器按任务要求保留网络，因此当前结果不声明 closed-book。
- SWE-bench 如果要声明 closed-book，必须机械验证 shell 子进程的网络边界；提示词禁止联网或隐藏工具 schema 不够。

“开到最大”不能覆盖 benchmark 自己声明的 agent/verifier 时限。Terminal-Bench 正式运行使用 `tb_agent_timeout_multiplier=1`，即完整保留每题官方预算；`tb_timeout_ms` 留空。不要移除官方预算，也不要添加 `max_steps`。工具子进程寿命由上面的最大 `workspaceProcessDurationMs` 控制。

## 凭据与换模型

有两类独立凭据：

- `BEST_AGENT_SOURCE_TOKEN`：只用于 CI 检出私有 best-agent source 或下载私有 candidate asset。它不是模型 token。
- `BENCHMARK_PROVIDER_API_KEY`：只用于模型请求。当前 `materialize-ci-provider.mjs` 要求未过期的 dim OAuth JWT。

从本机已登录的 dimcode OAuth 安全同步凭据，不把 token 放进 argv 或 shell history：

```bash
cd /absolute/path/to/best-agent-benchmark
node scripts/sync-secrets.mjs \
  --repo Simon-He95/best-agent-benchmarks \
  --model deepseek-v4.1-flash

gh secret list --repo Simon-He95/best-agent-benchmarks
```

`gh secret list` 只能核对名称和更新时间，不能证明 token 尚未过期。smoke 中的 `Verify provider credential` 和 `Materialize the frozen provider identity` 必须通过后才能启动正式全量。

没有当前模型的有效凭据时不能继续该模型的尝试。换模型不是“恢复原 run”，而是新的冻结 profile 和新的 benchmark run：

1. 确认新 credential 的 provider、base URL 和兼容模式。
2. 修改对应 benchmark 配置中的完整 `provider` 对象，而不只改 workflow 输入。
3. 当前 materializer 只允许 `deepseek-v4-flash/high` 和 `deepseek-v4.1-flash/max`。使用其他模型时，必须先最小修改 `scripts/materialize-ci-provider.mjs` 的准入规则并更新 `test/materialize-ci-provider.test.mjs`；不得绕过校验。
4. 运行测试、review、smoke，再发起新的 full run。旧 run 和旧结果保持不变。

`bench.yml` 的 `swe_bench_model` 只允许诊断 override；正式 500 题 run 会拒绝与冻结候选不一致的模型。

## best-agent 本地改动后如何进入 CI

未提交或只存在本机的代码不能成为 CI 候选。先在 best-agent 仓库验证并推送精确 commit：

```bash
cd /absolute/path/to/best-agent
corepack enable
corepack install
pnpm install --frozen-lockfile
pnpm test
pnpm pack:tui
git rev-parse HEAD
git status --short
best_agent_branch=codex/my-benchmark-candidate
git push origin "$best_agent_branch"
```

`pnpm pack:tui` 构建并 smoke-test **当前宿主平台** 的 SEA npm 包。在 Apple Silicon 上它不是 Linux x64 benchmark 候选，也不会留下可复用的 standalone `best-agent.cjs`；不能把本地 Darwin 产物上传后冒充 Linux 候选。

Terminal-Bench 的正确做法是把已推送的 commit 写入 `config/terminal-bench.json`，由 `tb-candidate` 在 `ubuntu-24.04` 执行 `pnpm pack:tui`，再冻结 Linux x64 binary、tarball、runtime lock、Node binary 和 build report 的哈希。不要手填这些运行时哈希，也不要用 `latest`。

源码发生任何影响模型行为的改动后，已有 candidate receipt 立即失效。更新 source commit，重新跑 smoke 和 full；不得继续旧 run 或把新产物塞进旧 run。

## Terminal-Bench 4.0：完整执行流程

### 1. 更新单点事实源

编辑：

- `config/terminal-bench.json`
  - `cli.sourceCommit`：已推送的完整 40 位 commit。
  - `cli.cliVersion`：必须与该 commit 的 CLI package version 一致。
  - `provider`：model、reasoning effort、base URL、compatibility 和 transport profile。
  - benchmark/corpus、权限和时限没有明确版本变更时不要顺手修改。
- `config/terminal-bench-batches.json`：只有冻结 corpus 或 GPU eligibility 变化时才重新生成/修改；必须完整、唯一、按 corpus 顺序覆盖 63 个 Docker-eligible 任务，每批不超过 10。
- `scripts/materialize-ci-provider.mjs` 和对应测试：仅在新增 provider profile 时修改。

验证本地控制面：

```bash
node --test test/terminal-bench.test.mjs test/materialize-ci-provider.test.mjs
git diff --check
git diff -- config/terminal-bench.json config/terminal-bench-batches.json \
  scripts/materialize-ci-provider.mjs test/materialize-ci-provider.test.mjs
```

把修改提交到独立 PR。先让 best-agent 源码 CI 和 benchmark PR checks 都通过，再合并 benchmark PR。

### 2. smoke

```bash
batch="candidate-smoke-$(date -u +%Y%m%dT%H%M%SZ)"
benchmark_ref=codex/my-benchmark-candidate
gh workflow run terminal-bench.yml \
  --repo Simon-He95/best-agent-benchmarks \
  --ref "$benchmark_ref" \
  -f run_tb_smoke=true \
  -f run_tb=false \
  -f tb_run_full=false \
  -f tb_batch="$batch" \
  -f tb_agent_timeout_multiplier=1 \
  -f tb_timeout_ms=
```

找到刚触发的 run 并验证：

```bash
gh run list --repo Simon-He95/best-agent-benchmarks \
  --workflow terminal-bench.yml --limit 5
smoke_run_id=123456789
gh run view "$smoke_run_id" --repo Simon-He95/best-agent-benchmarks \
  --json status,conclusion,headSha,jobs
```

smoke 的 candidate、corpus、plan 三个冻结 job 必须成功，单题必须实际进入模型阶段并上传 immutable artifact。Verifier reward 为 0 可以是模型结果；candidate 下载、provider materialize、容器启动或 evidence 缺失则是环境/harness 问题，不能当成正常 smoke。

### 3. 正式 63 题 full run

只有用户明确授权后才能 dispatch。先确保 `master` 是已审核 commit，并准备标签为 `terminal-bench-long` 的一次性 self-hosted runner；`cumulative-layout-shift` 会等待该 runner，其余任务使用 GitHub-hosted Ubuntu。Apple Silicon runner 必须设置 `DOCKER_DEFAULT_PLATFORM=linux/amd64` 并验证容器内 `uname -m` 为 `x86_64`。

```bash
batch="candidate-full-$(date -u +%Y%m%dT%H%M%SZ)"
gh workflow run terminal-bench.yml \
  --repo Simon-He95/best-agent-benchmarks \
  --ref master \
  -f run_tb=true \
  -f run_tb_smoke=false \
  -f tb_run_full=true \
  -f tb_batch="$batch" \
  -f tb_agent_timeout_multiplier=1 \
  -f tb_timeout_ms=
```

立即做去重和启动验收：

```bash
gh run list --repo Simon-He95/best-agent-benchmarks \
  --workflow terminal-bench.yml --limit 10 \
  --json databaseId,headSha,status,conclusion,createdAt,url
formal_run_id=123456789
gh run view "$formal_run_id" --repo Simon-He95/best-agent-benchmarks \
  --json status,conclusion,headSha,jobs
gh api "repos/Simon-He95/best-agent-benchmarks/actions/runs/$formal_run_id/artifacts"
```

预期是 66 个 job：3 个冻结 job + 63 个 generation job；generation 最多 8 个并行。三个冻结 job 成功、多个任务进入 `Generate and freeze the task attempt` 且没有成批 setup/provider/harness 失败后，才算正常启动。

### 4. 完成后验证

下载 aggregate report，或从冻结任务 artifacts 重新做只读分析：

```bash
formal_run_id=123456789
gh run download "$formal_run_id" \
  --repo Simon-He95/best-agent-benchmarks \
  --name "terminal-bench-report-$formal_run_id" \
  --dir "./evidence/terminal-bench-$formal_run_id"

gh workflow run terminal-bench-analysis.yml \
  --repo Simon-He95/best-agent-benchmarks \
  --ref master \
  -f source_run_id="$formal_run_id"
```

必须核对：

- report 的 `cli.sourceCommit`、candidate hashes、model/effort 与预声明一致。
- `coverage.expectedEligible=63`、`present=63`、无 duplicate/missing task。
- 每题存在 frozen result、完整 attempt evidence、terminal patch/hash 和未改写 stdout/stderr。
- `passAt1` 只有在完整、无 error/not-evaluated/incomplete evidence 时才可非空。
- failure analysis 的 model/tool/provider/infra/harness 分类只是证据派生视图，不覆盖 Harbor canonical disposition。

## SWE-bench Verified

### 原有正式流程

`.github/workflows/bench.yml` 使用 `config/best-agent-candidate.json` 的 npm/SEA 候选，并把生成与官方 Docker evaluator 分开。`config/swe-bench-verified.json`、`config/swe-bench-full-batches.json` 和 `config/best-agent-candidate.json` 是 corpus、500 题计划和候选的单点事实源。

当前 `config/best-agent-candidate.json` 的 `formalBenchmarkReady=false`。在候选 receipt、控制闭包哈希和正式 admission 未重新冻结并审核前，不要提供或执行一个“新源码 500 题”的 full-run 命令。

### fixed Node + CJS 诊断流程

这条链路读取：

- `config/node-bundle-candidate.json`：私有 Release asset、CJS bytes/SHA-256、固定 Node archive/binary、当前首题镜像。
- `config/node-bundle-generation.json`：candidate ID、provider、最大 model cycles、外层 watchdog 和官方 evaluator pin。
- `config/node-bundle-batch-*.json` 与对应 workflow：预冻结的诊断任务。

现有候选可以先做无模型 preflight：

```bash
gh workflow run node-bundle-preflight.yml \
  --repo Simon-He95/best-agent-benchmarks \
  --ref master
```

具体 `node-bundle-one.yml` / `node-bundle-batch*.yml` 均绑定既有候选、模型和任务，只能用于其冻结诊断目的。它们没有“使用本地最新代码”的参数，也不构成 500 题 pass@1。

本地源码改动后，**不能**只运行 `pnpm pack:tui` 然后重跑这些 workflow。当前仓库没有把任意 source commit 可靠导出为 standalone Linux `best-agent.cjs`、发布私有 immutable asset、更新全部 receipt 并生成通用 500 题计划的一键脚本。要把 SWE-bench 全面迁移到 fixed Node+CJS，必须先实现并审核新的 candidate-freeze job 和 full-run workflow；完成前应明确标注这个缺口，不能手工换 asset 后沿用旧 candidate ID。

一个合格的 SWE Node full workflow 至少要做到：

1. 在 Linux x64 从精确 source commit 生成 standalone CJS，冻结 source/lock/CJS/Node hashes 和 dependency closure。
2. 从 `config/swe-bench-verified.json` 取得固定 500 题 corpus，并从 `config/swe-bench-full-batches.json` 精确覆盖全部任务。
3. 每题只提供 frozen `base_commit`，删除未来 refs、reflog 和可达 future objects；模型容器不能读取 controller、grader、Docker socket 或其他题。
4. 在保持任务内 `unrestricted/read/write/exec/host/path` 的同时，机械证明 closed-book 网络边界。
5. 每题一次模型调用，保存完整 trajectory，冻结 patch/hash 后在 fresh official SWE-bench Docker evaluator 中评测。
6. 只认 pinned evaluator 的 canonical record；aggregate 对 missing、inconclusive 和 recovery provenance fail closed。

## 接入其他 benchmark 的 Node 合同

不要复制某个旧 run 的硬编码 workflow。新 benchmark 至少需要以下可审计阶段：

1. `config/<benchmark>.json`：冻结 source candidate、Node/CJS 或 SEA 形式、provider、权限、时限、benchmark/evaluator 版本。
2. candidate job：从精确 commit 构建一次，输出不可变 candidate receipt；所有任务下载同一 artifact。
3. corpus job：下载固定版本并记录完整 manifest/hash，不把隐藏 evaluator 材料放进模型 workspace。
4. plan job：在模型调用前固定完整任务列表、分批和唯一 formal run ID。
5. generation job：每题一次 headless CLI 调用，最大任务内权限，保存完整 trajectory、process receipt、stdout/stderr 和 frozen patch。
6. evaluator job：与模型隔离，使用 benchmark 官方 evaluator；不得将输出反馈给 generation。
7. aggregate/analysis job：检查完整覆盖和证据，不重新评分，不把诊断 subset 变成 pass@1。

若 benchmark 要求 closed-book，还必须在 shell 层阻断并验证网络；若任务规范要求网络，则保留网络并在报告里如实声明。权限、网络和 benchmark 时限都必须由配置和 receipt 表达，不能只写在提示词或文档里。

## 变更后到底更新什么

| 变更 | 必须更新 | 必须重新运行 |
| --- | --- | --- |
| best-agent 源码 | 精确 source commit；版本若变化也更新 | 源码 CI、benchmark tests、smoke、新 full run |
| 模型或 effort | benchmark provider profile、materializer 准入/测试、credential | smoke、新 full run；旧 run 不继续 |
| 仅 token 轮换，模型身份不变 | GitHub secret；候选配置不变 | credential/materialize smoke；不得重跑已有 prediction |
| benchmark/corpus 版本 | dataset commit/tag/hash、任务数、batch plan、官方 evaluator pin | corpus/plan tests、smoke、新 full run |
| Node 版本或 CJS/SEA 字节 | Node archive/binary 和 candidate receipts/hashes | candidate preflight、smoke、新 full run |
| harness、权限或时限 | 对应配置、控制闭包/测试；说明可比性变化 | 完整 admission、smoke、新 full run |

任何一项不确定时先停在 preflight/smoke。不要让模型先跑，再根据结果补配置或决定哪些任务算数。
