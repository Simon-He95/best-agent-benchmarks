# Terminal-Bench 4.0 集成说明

本仓库在原有 SWE-bench Verified 流程之外,新增一条完全独立的 **Terminal-Bench 4.0** CI 跑分流水线。SWE-bench 的 workflow、脚本、配置与产物一律不动。

日常更新候选、切换凭据/模型、执行 smoke/full run 和验收产物时，使用[统一操作手册](benchmark-operator-runbook.md)。本文保留 Terminal-Bench 的实现说明。

## 基准与运行方式

Terminal-Bench 4.0 由 [Harbor](https://www.harborframework.com) 框架承载:

```bash
harbor run -p tasks/<task> --agent-import-path terminal_bench_best_agent:BestAgentCli \
  -m <model> -e docker -k 1 ...
```

- 数据集 = `harbor-framework/terminal-bench` 仓库 `v4.0.0` tag(commit `452bf305c6daa62fc59061d22133a7cbc7c1572e`),66 个任务,每个任务由 `task.toml` + `instruction.md` + `environment/`(Dockerfile + 起始文件)+ `tests/`(官方 verifier)组成,任务级 sha256 记录在 `tasks/dataset.toml`。
- 官方 verifier 由 Harbor 自动在独立容器里执行并把 Terminal-Bench 测试退出状态写成 `result.json` 的 `reward`;本仓库只按 Harbor 0.14 的 `reward=1` 投影 passed/failed，并保留独立 exception，从不自行解析测试输出。
- 完整推理轨迹通过 CLI 的 `--attempt-evidence`(JSONL)写入 `/logs/agent/`,随 trial 产物持久化。

## 单点事实源

- `config/terminal-bench.json` — 数据集 pin(commit/tag/dataset.toml sha256/任务数)、Harbor 版本 `0.14.0`、current CLI 的 source commit/版本/Linux target、provider 档案、GPU/资源超限任务清单、生成参数。
- `config/terminal-bench-batches.json` — 63 个 Docker-eligible 任务按 corpus 顺序切成 7 批(≤10/批)的冻结 full-run 计划;3 个 GPU 任务不在其中。

## CI 用法

Workflow:`Terminal-Bench 4.0`(`.github/workflows/terminal-bench.yml`)。candidate、corpus、plan、report 和绝大多数 generation job 使用 GitHub-hosted Ubuntu；`cumulative-layout-shift` 单独路由到带 `terminal-bench-long` 标签的一次性 self-hosted runner，并以 `linux/amd64` Docker 环境执行。没有该 runner 时该题会保持 queued，不能用其他环境静默替代。

Repository secret `BEST_AGENT_SOURCE_TOKEN` 必须是可读取 `config/terminal-bench.json` 所指定 private source repository 的最小权限 token；它只传给 source checkout，且 checkout 后不持久化。Provider token 仍由独立的 `BENCHMARK_PROVIDER_API_KEY` 拥有。

| 输入 | 说明 |
| --- | --- |
| `run_tb_smoke` | 单任务连通性冒烟(`terminal-bench/batched-eval-parity`) |
| `run_tb` | 运行生成流水线 |
| `tb_tasks` | 预声明任务列表(逗号分隔,覆盖 offset/limit,≤10) |
| `tb_limit` / `tb_offset` | 按 corpus 顺序切片 |
| `tb_run_full` | 63 个 eligible 任务全量(使用冻结批次计划,须 pin 配置模型) |
| `tb_agent_timeout_multiplier` | 任务声明的 agent 超时乘数；workflow 默认和正式运行均为 `1`，完整保留官方任务预算 |
| `tb_timeout_ms` | 显式 provider/CLI 超时;空值由任务 agent 预算推导 |

流程:`tb-candidate`(每条 run 复用 `config/terminal-bench.json` 里冻结的 candidate pin，先在下载产物上校验 receipt/hash；只有显式 `tb_freeze_candidate=true` 才从精确 source commit 重新构建并冻结一次 Linux SEA)与 `tb-corpus`(sparse 拉取任务元数据 + 冻结 manifest)→ `tb-plan`(批次校验,恢复批次必须命中 `config/terminal-bench-recovery.json` 的冻结声明)→ `tb-generate`(每任务下载同一 candidate artifact + sparse 检出一个任务目录 + `harbor run` 一次)→ `tb-report`(聚合报告)。

看结果:workflow run 页面的 Job summary,或下载 artifact:

- `terminal-bench-report-<run-id>/report.json` / `report.json.md` — 总报告(表 + 逐任务判定)
- `terminal-bench-task-<run-id>-<task>/` — 每个任务的冻结产物(candidate receipt、结果 JSON、evidence JSONL、未改写的 CLI stdout/stderr、process receipt、Harbor trial 目录及各自 hash)
- `terminal-bench-corpus-<run-id>/` — 冻结的 corpus manifest

`report.json` 语义:`passRate` = passed/expected;`passAt1` 仅在 full-run 且覆盖完整时非空,否则为 `null`(诊断)。

## 诊断口径的当前跑分(2026-09-14,不是可发布的 pass@1)

63 个 Docker-eligible 任务现在全部有判定记录(3 个 GPU 任务按计划排除),但**不能作为 pass@1 发布**:判定跨三个 candidate 身份(59 / 3 / 1),其中 4 题来自恢复 run,17 题没有 pass/fail 判定,且正式 run 并行期间有 4 题撞 6h 平台上限。

| 判定 | 数量 | 说明 |
| --- | --- | --- |
| passed | 8 | embedding-drift-monitor、intrastat-meldung、layout-config-recreation2、medical-claims-processing、mvcc-lsm-compaction、protein-autointerp-disulfide、react-lead-form、telecom-entity-resolution |
| failed | 38 | harness 完成、官方 verifier reward 0 |
| error | 17 | 无判定:9 provider transport、6 tool terminal cause、2 harness/verifier 异常(其中 1 题为任务自身镜像构建失败) |

两个口径都只是诊断值,`passAt1` 保持 `null`:仓库口径 `passRate = passed/expected` = **8/63 = 12.7%**(无判定题计为未通过);只看有 pass/fail 判定的 46 题则 8/46 = 17.4%。

判定来源:

- 正式全量 run 34757660356(candidate `…-565089632a08-…`,58/63 覆盖):8 passed / 34 failed / 16 error。
- 恢复 run 34790194397(candidate `…-0289dc71725d-…`):layout-config-recreation failed、payments-pipeline-fix failed、freecad-impeller error。
- 恢复 run 34798815742(candidate `…-fb439a62e41e-…`):formal-crypto failed。
- 恢复 run 34819620610(复用 pin 的 `…-565089632a08-…`):distributed-dedup failed,2h02m。

会污染该数字的因素:9 题的 provider transport 失败使它没有真实作答判定;重任务在 4 CPU / 16 GB hosted runner 上超出任务资源规格;4 题(含 distributed-dedup、formal-crypto)曾在 6h 平台上限被取消。要得到可发布的 pass@1,需要在**同一 frozen candidate、同一批 run** 下把 63 题全部重跑一次(每题仍只允许一次模型尝试)。

## 与本仓库 SWE-bench 流程的差异(如实标注)

- **CLI candidate**:候选身份(candidateId)由构建出来的 SEA 与 tarball 字节派生,而 CI 重建同一 source commit 不保证字节一致:正式 run 34757660356 记录 `cli-0.0.3-beta.25-c692211-565089632a08-21f3137069de`,同一 commit 的重建 run 34798815742 记录 `cli-0.0.3-beta.25-c692211-fb439a62e41e-fcfbfa548647`(source lockfile、Node 与 runtime deps 相同;build report 只有 bundleBytes 18125259→18125269、blobBytes 19487918→19488048 的差异),使判定曾分散在三个 candidate 身份上。现在 `config/terminal-bench.json` 的 `cli.candidate` 冻结唯一一份 candidate artifact(run/artifact id + receipt 与字节 hash),每条 run 复用并逐字段/逐字节校验(`scripts/verify-terminal-bench-candidate.mjs`,fail closed);重建只是显式动作(`tb_freeze_candidate=true`)。该 artifact 的 Actions retention 为 90 天(2026-09-13 冻结),过期后须重新冻结 pin 或改存 release asset。没有完整 receipt 时任务 fail closed,不回退到旧 npm Linux 包或 Darwin host bridge。
- **执行 profile**:CLI 在 Harbor task container 内直接运行;`processIsolation=host` 指 container 内 CLI 的进程面。其规范身份是 `explicit-custom / plain / unrestricted / host / path / read+write+exec`,不是交互式 Product `full access`。
- **环境真实、资源受限**:agent 在任务容器内执行(真实 Linux 环境),但 CI runner 为 4 CPU / 16 GB,故 `--cpus ignore --memory ignore`(不强行套用任务资源规格),超资源任务(`resourceExceededTasks`)会慢或失败,已在 config 中标出。
- **失败归因(证据派生,不覆盖判定)**:`scripts/terminal-bench-failures.mjs` 把每个非通过记录归为 `env-blocked`、`infra`、`agent-timeout`、`provider`、`tool`、`harness`、`model`、`verifier`、`inconclusive`,只转录冻结记录与日志,既不改写 Harbor 的 canonical disposition,也从不触发重试。其中 `env-blocked` 专指**任务自身的镜像/环境构建失败**(Harbor 在 `tools/terminal-bench-source/tasks/<name>` 下 compose 任务与 verifier 容器时失败):该 attempt 根本无法被评测,属上游 dataset/环境漂移,既不是模型失败也不是本仓库 harness/CLI 失败,不得计入任何模型分数或恢复判定。已知实例(run `34757660356` 与补跑 `34790194397`):`terminal-bench/freecad-spring-clip`、`terminal-bench/freecad-impeller`,两者都停在任务 Dockerfile 的 `pip install 'gnucleus-freecad-validator[render]==0.1.3'`——它要卸载 conda 以 distutils 方式安装的 `vtk 9.2.6` 而失败(exit 1),是任务镜像与当前包索引漂移的结果。
- **GPU 任务排除**:3 个任务(`fp8-rmsnorm-gemm`、`jax-speedrun-gpu`、`math-eval-grader`)需要 GPU,Docker 环境无法运行,全量计划显式排除并记录。需要 GPU 时可另走 Modal(需 `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`)。
- **网络边界**:CLI 的 network ToolBinding 被排除(`--tool-exclude network`),但容器网络对任务开放(TB 任务常需下载依赖),shell 子进程可达外网。适合诊断/内部测量,不宣称 "closed-book"。
- **超时策略**:正式运行使用 Harbor `--agent-timeout-multiplier 1`，不压缩任务声明的 agent 预算；`tb_timeout_ms` 留空，由任务预算推导 provider/CLI timeout。工具子进程使用 `workspaceProcessDurationMs=2147000000`，且不添加 `max_steps`。超时仍按 error 保留在报告中，不能据此自动重试已有 prediction。
- **provider**:复用同一份 frozen provider 档案(`materialize-ci-provider.mjs`),插件把 `provider.json` + dimcode home 物化进容器,CLI 在容器内按正常解析路径读取。

## 本地冒烟(有 Docker 的 macOS)

Apple Silicon 上必须强制 amd64 平台。先从冻结 source commit 在 Linux x64 主机生成 `results/candidate/{candidate.json,build-report.json,best-agent-cli.tgz}`;candidate receipt 必须通过 harness 的 SHA-256 和身份校验,不能用本机 Darwin binary 代替:

```bash
export DOCKER_DEFAULT_PLATFORM=linux/amd64
uv tool install harbor==0.14.0
uv pip install --python "$(uv tool dir)/harbor/bin/python" -e ./tools/terminal-bench-agent
# 准备一个冻结清单(任何含 task.toml/instruction.md 的任务目录 + manifest.json)
BEST_AGENT_PROVIDER_CONFIG=/path/provider.json DIMCODE_HOME=/path/dimcode-home \
BEST_AGENT_PROVIDER_MODEL=deepseek-v4.1-flash \
BEST_AGENT_CLI_CANDIDATE_DIR=/path/to/results/candidate \
TB_ALLOW_UNPINNED_SOURCE=1 \
node scripts/terminal-bench-harness.mjs --task terminal-bench/<name> \
  --corpus manifest.json --source <repo-dir> --output out.json \
  --jobs-dir jobs --job-name local-smoke --model deepseek-v4.1-flash \
  --agent-timeout-multiplier 0.05 --candidate-id cli-smoke \
  --batch-id smoke --formal-run-id diagnostic-smoke
```

`TB_ALLOW_UNPINNED_SOURCE=1` 仅用于本地开发(跳过 git HEAD 校验),CI 永不设置。
