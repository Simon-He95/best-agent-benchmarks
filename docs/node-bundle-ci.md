# Frozen Node bundle CI

## 接手入口与当前状态（2026-09-09）

这是本轮运行交接入口，不依赖聊天上下文。先读本文件、仓库 `AGENTS.md` 和以下两个事实文件：

- [候选清单](../config/node-bundle-candidate.json)：唯一的本轮 bundle/Node/首题镜像身份。不是旧的 `config/best-agent-candidate.json` 所指 npm 候选。
- [失败题清单](../config/node-bundle-failed-tasks.json)：原冻结顺序的63题、base commit、原prompt哈希、原receipt/trajectory/official output哈希。只含标识与证据关联，不含参考补丁或失败测试提示。该文件是选择快照，不是新一轮完成状态；不要因新结果修改已冻结选择。

历史组合结果为437/500解决（87.4%），54 test-failed、9 no-prediction、0 pending；这是跨候选组合结果，`passAt1=null`。其来源哈希在失败题清单中。之后26个本地诊断尝试不等于新增官方通过题，不能加进437。旧canonical结果、失败证据和所有旧claim继续保留。

| 阶段 | 当前事实 |
| --- | --- |
| 固定Node+CJS接入 | 已提交 `db0c709944e1ceb6c1ed808d9ff20aefbac8dd8e`，已推送master |
| 本地验证 | 9/9定向测试、MJS语法、YAML解析、diff检查通过；不是完整做题证明 |
| 干净上下文审查 | 方案与实现均批准预检；尚不代表模型/评测阶段验收 |
| 真实hosted Linux预检 | [run34360907430](https://github.com/Simon-He95/best-agent-benchmarks/actions/runs/34360907430) success，job102497332067，1m10s，head与上述提交一致 |
| 下载产物并独立核验 | 22个process receipt的退出值和stdout/stderr字节数、SHA256全部匹配；10个ToolResult在first-next ModelRequest和provider wire逐项相同 |
| 运行时事实 | Node24.15.0/Linux x64；官方image内Python3.5.6及conda prefix正确；两个CLI SQLite库readonly quick_check通过；实际容器已移除 |
| 本轮真实做题/新评分 | **尚未启动，0新model attempt、0新official verdict**。当前workflow只有preflight入口 |
| 继续工作 | 用户已授权CI Node运行failed任务。正在接入单题generation→冻结prediction→fresh官方Docker evaluator；先首题成功完成全链路，再每批最多5个独立job |

预检artifact：`node-bundle-preflight-34360907430-1`，ID10107806003，789989 bytes，GitHub报告的archive digest为`sha256:e1297b977569d7b39dd990c599a44bedcdef0c5b824b60fb4199c0de9fff2ee4`。本地独立验证的是解压后的process/evidence哈希；不要把该陈述扩大成重新计算了ZIP哈希。Artifact有30天保留期，应在过期前归档，过期不代表通过证据可以凭空重建。

## 为什么未发布Node npm包也能运行

执行的是官方Node解释器加已冻结JavaScript文件：`node best-agent.cjs run ...`，不是安装一个不存在的npm Node版。

- CJS源候选为`local-spec100-epoch002-not-published`，含本地已验收修复；不能标成已发布beta.20或声称是clean HEAD可复现构建。
- 本地bundle已上传到私有[Release benchmark-cjs-1acde263f490](https://github.com/Simon-He95/best-agent/releases/tag/benchmark-cjs-1acde263f490)，release385559264、asset552863959、文件`best-agent.cjs`，17,930,440 bytes。具体哈希以候选清单为准。没有把bundle提交进Git，也没有发布npm。
- 公开benchmark仓库的CI使用已有Secret `BEST_AGENT_SOURCE_TOKEN`读取私有Release。该值只注入下载step；不进入模型容器、日志或上传产物。外部fork若无对应私有读取权限不能下载该候选，这不是公共匿名可复现发行版。
- 下载器同时验证GitHub资产metadata及实际CJS bytes/hash，再验证官方Node archive和解压binary。不能改成`latest`、重新build不同bytes或静默换npm候选。

## 不依赖本机目录的检查命令

以下都是只读检查/下载，不会重新做题：

```bash
gh run view 34360907430 --repo Simon-He95/best-agent-benchmarks --json status,conclusion,headSha,jobs
gh api repos/Simon-He95/best-agent-benchmarks/actions/runs/34360907430/artifacts
gh run download 34360907430 --repo Simon-He95/best-agent-benchmarks --name node-bundle-preflight-34360907430-1 --dir ./evidence/preflight-34360907430
node --test test/download-node-bundle.test.mjs test/node-bundle-preflight.test.mjs
```

只在明确需要重新做工程预检时使用下面的dispatch；它**不是做题命令**。dispatch后必须核对实际head，GitHub不接受这里用缩写commit代替branch/tag：

```bash
gh workflow run node-bundle-preflight.yml --repo Simon-He95/best-agent-benchmarks --ref master
```

不要为了“继续”再次启动旧`bench.yml`、旧本地runner或整批63题；它们不等于新Node链路。真实generation命令在后续实现及审查完成后由`docs/node-bundle-generation-plan.md`记录，当前没有可诚实提供的已就绪做题命令。新的调度状态/run ID/每题claim/terminal链接也只在该阶段记录更新，不改冻结选择。

## 接续单题的明确工作

1. 复用现有Node下载器和预检证据；为首题`django__django-10097`补真实base-only Git、refs/reflogs/未来objects及官方helper材料清理。预检的`modelAdmission=false`、`sanitationReviewed=false`不能伪造为true。
2. 形成最小generation方案并用全新上下文GPT6审查，通过后实现；不重审已验收Harness、不增加重试或通用架构层。现有协调任务正在承担此步骤，换工具前先检查其文件/CI，避免双dispatch。
3. 固定同一候选和模型配置；provider Secret只在真实模型阶段进入独立容器。容器内跨workspace full access不代表可以访问controller、Docker socket、grader或其他题。
4. 一题一个不可变claim与一次CLI调用；显式记录外层watchdog和真实exit/signal/timeout，不把它们改成model verdict。模型运行期间不暴露test_patch、测试答案、grader日志或先前失败分析。
5. 确认模型容器及后代已停止，安全导出；不要在controller执行模型修改过的Git/config/filter。用fresh trusted容器捕获exact patch/hash，完整trajectory机械验收后才启动一次fresh官方Docker evaluator。
6. 同job优先完成做题和评测，复用已拉镜像；每题独立job，后续每批最多5题。不在Mac继续拉大镜像，不做global prune。不根据grader结果改同一次尝试、重跑canonical或挑patch。
7. 每题保存候选/Node/镜像/任务/配置身份、claim、全stdout/stderr、process/evidence receipt、patch hash、canonical记录及job/step失败原因；失败也上传，经凭据检查。无法验收就记录缺口，不伪称完成。仅最终canonical结果更新组合报告，保留完整历史。

## 同一台Mac接手时的本地证据与协作

- 当前干净工作区：`/Users/Simon/Github/best-agent-benchmarks-node-ci`，本地分支`codex/frozen-node-benchmark`，内容已推公共`master`。原`/Users/Simon/Github/best-agent-benchmarks`有大量用户未提交改动，**不要reset/clean/stash或混入本轮commit**。
- 本轮计划、两次review及下载证据：`/Users/Simon/Documents/Codex/2026-09-09/remaining63-ci-node-bundle/`。方案review任务`01a0866c-ac59-7112-babb-31eb8b98f33f`；实现review任务`01a08676-6a51-7113-a625-80a689247777`。
- 可复用但尚非CI可移植实现：`/Users/Simon/Documents/Codex/2026-09-09/remaining63-official-docker/`的run/capture/verify/evaluate脚本和frozen/ledger。它们含Mac绝对路径及旧ARM capture依赖，**不能直接执行当作CI版**。该round本地拉镜像失败时没有model attempt。
- 更早26个本地诊断与已冻结候选：`/Users/Simon/Documents/Codex/2026-09-08/local-remaining63/`；剩余63题分析：相邻`benchmark-context-recovery/`。旧官方结果仍在原benchmark工作区`.tmp/beta13-local-eval.0xB6JZ/`和相关CI artifacts。路径丢失时使用记录的hash/CI来源追溯，不填造结果。
- 现有协调任务：`01a08415-889f-7ad0-9d01-2269c2d24a93`；worker001 `01a08415-fc9e-71a0-9cd1-3b3f4b6711d6`；worker002 `01a08416-03b4-7d13-8fda-71db8b5006d5`。它们是协作定位信息，不是运行事实；状态以仓库文件、实际process和GitHub run为准。
- 现有`63-harness`半小时监控目前只读跟进CI迁移，旧本地下载/旧CI dispatch保持HOLD。不要另建重复监控。用户已授权新Node阶段推进，监控应在新workflow就绪后按真实run ID更新。

## 已冻结的边界说明

Engineering preflight for the local-spec100-epoch002 candidate. This is not the published beta.20 executable and is not a scored benchmark run. Existing SEA workflows and their candidate configuration remain unchanged.

`config/node-bundle-candidate.json` owns this diagnostic candidate's exact CJS, Node archive/binary, and first official instance image identities. CI retrieves the CJS from a private source-repository asset; the source token is scoped to that download step, never supplied to the container. No source maps or source checkout are distributed publicly.

The initial workflow only runs a scripted local provider in an unprivileged, no-host-mount Linux container. It has no real-provider credentials and cannot dispatch task models or an evaluator. It records runtime/image facts, raw stdout/stderr, tool evidence, storage and environment checks. The container's full-access tool policy applies inside the container, including paths outside its workspace; it grants no access to the runner filesystem or Docker socket.

Actual hosted preflight evidence and a fresh review are required before adding the one-task model/evaluator stage. That stage must preserve one attempt, full trajectory, terminal patch hash, fresh official evaluator isolation, and canonical verdict immutability. The selected diagnostic result must retain `passAt1: null`; no closed-book claim is made. Previous local attempts remain independent and immutable.

Architecture classification: Conformance through existing Application/external-system and output boundaries (080/084). Benchmark controller owns invocation, process receipts and artifact admission; Kernel remains sole owner of Run facts. Changes to contribution cardinality, RuntimeState, KernelInput/Directive, transition, cursor, lifecycle, and Kernel authority: None. No Harness retries, fallback, or evaluator feedback into a Run.
