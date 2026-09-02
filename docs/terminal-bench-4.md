# Terminal-Bench 4.0 集成说明

本仓库在原有 SWE-bench Verified 流程之外,新增一条完全独立的 **Terminal-Bench 4.0** CI 跑分流水线。SWE-bench 的 workflow、脚本、配置与产物一律不动。

## 基准与运行方式

Terminal-Bench 4.0 由 [Harbor](https://www.harborframework.com) 框架承载:

```bash
harbor run -p tasks/<task> --agent-import-path terminal_bench_best_agent:BestAgentCli \
  -m <model> -e docker -k 1 ...
```

- 数据集 = `harbor-framework/terminal-bench` 仓库 `v4.0.0` tag(commit `452bf305c6daa62fc59061d22133a7cbc7c1572e`),66 个任务,每个任务由 `task.toml` + `instruction.md` + `environment/`(Dockerfile + 起始文件)+ `tests/`(官方 verifier)组成,任务级 sha256 记录在 `tasks/dataset.toml`。
- 官方 verifier 由 Harbor 自动在独立容器里执行并给出 reward;本仓库只转录 Harbor 的 `result.json` 判定(passed/failed/error),从不自行解析测试输出。
- 完整推理轨迹通过 CLI 的 `--attempt-evidence`(JSONL)写入 `/logs/agent/`,随 trial 产物持久化。

## 单点事实源

- `config/terminal-bench.json` — 数据集 pin(commit/tag/dataset.toml sha256/任务数)、Harbor 版本 `0.14.0`、CLI pin(`@best-agent/cli-linux-x64-gnu@0.0.3-beta.1` + integrity)、provider 档案、GPU/资源超限任务清单、生成参数。
- `config/terminal-bench-batches.json` — 63 个 Docker-eligible 任务按 corpus 顺序切成 7 批(≤10/批)的冻结 full-run 计划;3 个 GPU 任务不在其中。

## CI 用法

Workflow:`Terminal-Bench 4.0`(`.github/workflows/terminal-bench.yml`),全部在 `ubuntu-latest` 上运行(GitHub macOS runner 不提供 Docker;arm64 不支持嵌套虚拟化)。

| 输入 | 说明 |
| --- | --- |
| `run_tb_smoke` | 单任务连通性冒烟(`terminal-bench/batched-eval-parity`) |
| `run_tb` | 运行生成流水线 |
| `tb_tasks` | 预声明任务列表(逗号分隔,覆盖 offset/limit,≤10) |
| `tb_limit` / `tb_offset` | 按 corpus 顺序切片 |
| `tb_run_full` | 63 个 eligible 任务全量(使用冻结批次计划,须 pin 配置模型) |
| `tb_agent_timeout_multiplier` | 任务 agent 超时乘数,默认 0.1875(=8h×0.1875≈90min/任务) |
| `tb_job_timeout` | 单个生成 job 超时(默认 480min) |

流程:`tb-corpus`(sparse 拉取任务元数据 + 冻结 manifest)→ `tb-plan`(批次校验)→ `tb-generate`(每任务一个矩阵 job:sparse 检出一个任务目录 + `harbor run` 一次)→ `tb-report`(聚合报告)。

看结果:workflow run 页面的 Job summary,或下载 artifact:

- `terminal-bench-report-<run-id>/report.json` / `report.json.md` — 总报告(表 + 逐任务判定)
- `terminal-bench-task-<run-id>-<task>/` — 每个任务的冻结产物(结果 JSON、evidence JSONL、CLI stdout、Harbor trial 目录)
- `terminal-bench-corpus-<run-id>/` — 冻结的 corpus manifest

`report.json` 语义:`passRate` = passed/expected;`passAt1` 仅在 full-run 且覆盖完整时非空,否则为 `null`(诊断)。

## 与本仓库 SWE-bench 流程的差异(如实标注)

- **CLI 版本不同**:容器内只能装 Linux 构建;npm 上 Linux 最新为 `0.0.3-beta.1`(2026-08-16 发布),而 SWE-bench 候选是 `darwin-arm64 0.0.3-beta.17`。因此 TB 跑分是**另一个候选的测量**,不与 SWE-bench pass@1 混淆;CLI 身份写入每个冻结结果。
- **环境真实、资源受限**:agent 在任务容器内执行(真实 Linux 环境),但 CI runner 为 4 CPU / 16 GB,故 `--cpus ignore --memory ignore`(不强行套用任务资源规格),超资源任务(`resourceExceededTasks`)会慢或失败,已在 config 中标出。
- **GPU 任务排除**:3 个任务(`fp8-rmsnorm-gemm`、`jax-speedrun-gpu`、`math-eval-grader`)需要 GPU,Docker 环境无法运行,全量计划显式排除并记录。需要 GPU 时可另走 Modal(需 `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`)。
- **网络边界**:CLI 的 network ToolBinding 被排除(`--tool-exclude network`),但容器网络对任务开放(TB 任务常需下载依赖),shell 子进程可达外网;不存在 macOS Seatbelt 级别的 exec 网络隔离。适合诊断/内部测量,不适合宣称"closed-book"。
- **超时策略**:默认把每个任务的 8h 官方 agent 超时压到 ~90min(Harbor `--agent-timeout-multiplier`),超时任务的判定为 error,报告可见。
- **provider**:复用同一份 frozen provider 档案(`materialize-ci-provider.mjs`),插件把 `provider.json` + dimcode home 物化进容器,CLI 在容器内按正常解析路径读取。

## 本地冒烟(有 Docker 的 macOS)

Apple Silicon 上必须强制 amd64 平台(否则会拉到 arm64 基础镜像,与 x64 CLI 不匹配);CN 网络建议用镜像源(与 `config/terminal-bench.json` 的 sha512 校验搭配,镜像字节与官方一致):

```bash
export DOCKER_DEFAULT_PLATFORM=linux/amd64
export BEST_AGENT_CLI_REGISTRY=https://registry.npmmirror.com   # CLI tarball
export BEST_AGENT_NPM_REGISTRY=https://registry.npmmirror.com   # 运行时依赖
export BEST_AGENT_NODE_MIRROR=https://npmmirror.com/mirrors/node # node 镜像
uv tool install harbor==0.14.0
uv pip install --python "$(uv tool dir)/harbor/bin/python" -e ./tools/terminal-bench-agent
# 准备一个冻结清单(任何含 task.toml/instruction.md 的任务目录 + manifest.json)
BEST_AGENT_PROVIDER_CONFIG=/path/provider.json DIMCODE_HOME=/path/dimcode-home \
BEST_AGENT_PROVIDER_MODEL=deepseek-v4-flash \
BEST_AGENT_CLI_PACKAGE=@best-agent/cli-linux-x64-gnu \
BEST_AGENT_CLI_VERSION=0.0.3-beta.1 \
BEST_AGENT_CLI_INTEGRITY='sha512-...' \
TB_ALLOW_UNPINNED_SOURCE=1 \
node scripts/terminal-bench-harness.mjs --task terminal-bench/<name> \
  --corpus manifest.json --source <repo-dir> --output out.json \
  --jobs-dir jobs --job-name local-smoke --model deepseek-v4-flash \
  --agent-timeout-multiplier 0.05 --candidate-id cli-smoke \
  --batch-id smoke --formal-run-id diagnostic-smoke
```

`TB_ALLOW_UNPINNED_SOURCE=1` 仅用于本地开发(跳过 git HEAD 校验),CI 永不设置。