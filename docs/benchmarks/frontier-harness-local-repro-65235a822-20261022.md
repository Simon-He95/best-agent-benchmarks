# run 39557190033 的 7 个 failed 格：用 best-agent main `65235a822` 的本地重跑（tool_call 归因复核）

**性质：本地诊断重跑，不是官方读数。** 它不产出 pass@1、不产出任何 rate，不替换 run 39557190033 / 39620264048 / 39700728172 / 39721121070 的任何判定、记录或 artifact。这里只有一个目的：把上一轮记下的 7 个 failed 格用当前 main 重放一次，逐条核对失败是否由 **我们的 tool_call 准入/参数限制**（文件不存在、路径写错、cwd 错等）造成。

## 0. 为什么会有这一份

`docs/benchmarks/frontier-harness-tool-call-attribution-39557190033.md` 的结论是：那 8 个 failed 格里 8 次硬拒绝都是工具按设计正确拒绝，失败来自传输中断、预算与真实难度。那份归因基于 0.0.14-beta.1（`5bc13e8`）。此后工具面改了四批（spec 425 根拒绝文案、426 exec 外壳补救、427 路径描述、430 provider 代理），而 39620264048 / 39700728172 / 39721121070 只覆盖了 meriyah 一格与部分 terminal-bench 格。本重跑补上"当前 main 上这 7 格还会不会被工具面挡住"这一问。

## 1. 候选与组合（逐字事实）

| 项 | 值 |
| --- | --- |
| 候选包 | `@best-agent/cli-linux-x64-gnu`，`0.0.16-beta.1` |
| source commit | `65235a822caa2eb5a6b6fe0f3b097adc3f6f1899`（main，含 PR445/446/447；**不含** PR448 的 `532224a31`） |
| binary sha256 | `6f832ee7a5117ac0e745dd2e220324f4ff68e686194969933405b0c2479514fe`（完整值同见 `.tmp/candidate-65235a822b/candidate.json`） |
| target / node | `linux-x64-gnu` / `v24.15.0`（容器内 Ubuntu 24.04，`--platform linux/amd64`） |
| 交付校验 | `scripts/verify-frontier-harness-candidate.mjs`：`verified=true`，7 项 check 全 pass（packaging.files/receipt/bytes/tarball/runtimeClosure、typecheck.source、runtime.binary） |
| 候选构建 | 容器内从只读挂载的本地 checkout `git clone --no-hardlinks` 后构建（避免宿主 macOS 的 `node_modules`/esbuild 平台泄漏），`pnpm pack:tui` → SEA → 打包 → 独立校验 |
| model | `glm-5.3`，reasoning `high`，transport `dim-oauth`（`https://dimagent.cn/v1`） |
| 任务镜像 | 与冻结清单同一批 `alexgshaw/<task>:20251031` |
| 每次尝试 | 每格 1 次，`--agent-timeout-multiplier 1`，并发 4，`pier`（`.tmp/pier-venv`）on docker |
| 网络 | 公开网络（harness 默认把 agent 阶段规范化成 `public`）。**本轮没有 filtered-egress 探针，也没有污染门**，所以这里不声明任何 "bounded" 或 "clean" |

**冻结清单的临时绑定**：`config/frontier-harness.json` 的 `cli` 块仍钉 `7d76cdc10`，候选校验器与 per-task harness 都读它。本地重跑脚本在整段运行期间把该 `cli` 块临时改成上表候选，退出时用 `trap` 从备份恢复；`git status --porcelain config/frontier-harness.json` 在运行前后都是空。

复算入口：`.tmp/repro-39721121070-all.sh`（一次性脚本，含绑定→构建→校验→跑 7 格→恢复）。`.tmp/` 不入库。

## 2. 结果（7 格逐字）

`durationMs` / `attemptBudgetMs` 取自每格 frozen 结果；`modelCalls` 取 `usage.modelCallCount`；`refusals` 是本格 evidence 里 `closure.kind != known` 或结构化 `code` 的硬拒绝数。

| 格 | disposition | reward | duration / budget | terminalCause | modelCalls | prompt tokens | total tokens | 硬拒绝 | 模型写的 write/edit/apply_patch |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| build-cython-ext | failed | 0 | 829.9s / 900s | stopped | 39 | 1,327,077 | 1,341,054 | 1 | 9（edit） |
| chess-best-move | failed | 0 | 914.1s / 900s | stopped | 18 | 395,988 | 423,283 | 0 | 0 |
| code-from-image | failed | 0 | 1,129.1s / 1,200s | stopped | 26 | 600,588 | 632,113 | 1 | 0 |
| dna-insert | failed | 0 | 1,786.4s / 1,800s | stopped | 8 | 112,155 | 116,034 | 0 | 0 |
| extract-elf | failed | 0 | 846.4s / 900s | stopped | 9 | 146,184 | 164,317 | 1 | 0 |
| gcode-to-text | failed | 0 | 891.9s / 900s | stopped | 30 | 1,151,397 | 1,169,819 | 0 | 10（write 8 / edit 2） |
| largest-eigenval | failed | 0 | 781.6s / 900s | stopped | 7 | 155,488 | 167,884 | 2 | 0 |

7/7 failed、7/7 `terminalCause=stopped`（都撞到自己那一格的 agent 预算）、7/7 reward 0。`pierExitCode` 全 0、`pierSignal` 全 null：容器、镜像、setup、候选安装都正常，**没有一格是 infra 或候选安装失败**。

唯一的进程级异常是 `gcode-to-text` 的 `NonZeroAgentExitCodeError`：该格 `deliveryTerminalCause=run-deadline`，agent 进程在 900s 截止时以 exit 1 结束（stderr/stdout 为空）。其余 6 格的 delivery 阶段是 `completed`。这是"撞预算"的正常收束，不是工具或候选故障。

### 2.1 模型调用全部是正常响应

每格的 evidence `model-outcome` 依次是 `{"response": N}`，N 与 `modelCallCount` 逐格相等（39/18/26/8/9/30/7），**没有一次 `connection` / `timeout` / `model-failure`**。这与 39557190033 的 6 次 transport 中断、累计 2,246s 被吞形成直接对照；同一 provider、同一 model、同一天内的不同时段，1 次尝试/格，**不能据此声称传输层已修好**——只能记"本轮没有复现"。

### 2.2 工具拒绝：5 次，逐条核对全部正确

工具面合计 164 次互不相同的调用（按 callId 去重，跨全部 snapshot）：`exec 116`、`read 18`、`edit 11`、`write 8`、`list 7`、`todowrite 3`、`stat 1`。硬拒绝只有 5 次：

| # | 格 | 调用（模型原样入参） | 回执 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | build-cython-ext | `exec {args:["-c","git clone --depth 1 --branch 0.5.3 https://github.com/SPOCKnots/pyknotid.git /app/pyknotid && python --version && …"], lifetimeMs:120000}` | `malformed-input`, `{code:"required", field:"command"}` | **正确**：模型自己的工具调用 JSON 里就没有 `command`（evidence 的 `model-outcome` 原文即 `{"args":[…],"lifetimeMs":120000}`）。它不是路径问题，是少了一个必填字段 |
| 2 | code-from-image | `read {path:"/app/code.png"}` | `binary-file`, `"file appears to be binary"` | **正确**：PNG 不是文本；本格随后改用 `exec` 处理图像 |
| 3 | extract-elf | `exec {command:"file", args:["a.out"], cwd:"/app"}` | `not-found`, `no executable named "file" on the frozen PATH` | **正确**：在该镜像里实查 `command -v file` 为空、`/usr/bin/file` 不存在 |
| 4 | largest-eigenval | `exec {command:"cc", args:["--version"]}` | `not-found` | **正确**：该镜像 `command -v cc gcc ld` 全空 |
| 5 | largest-eigenval | `exec {command:"ld", args:["-lpthread"]}` | `not-found` | 同上 |

没有一次是"路径写错 / cwd 解析到别处 / 准入层误拒"。本轮 5 次拒绝之后模型都继续走了下一轮（同格后续调用仍成功），没有一格在拒绝处终止。

### 2.3 "文件不存在"类：交付物一次都没有被尝试写过

| 格 | verifier 要求的交付物 | 本格所有调用里提到该路径的次数 | 实际写操作 |
| --- | --- | --- | --- |
| chess-best-move | `move.txt` | 0 | 0 |
| code-from-image | `output.txt` | 0 | 0 |
| gcode-to-text | `out.txt` | 0 | 10 次（全部 `/app/*.py` 草稿） |
| extract-elf | `extract.js` | 0 | 0（12 次调用全是 exec/read） |
| largest-eigenval | `eigen.py` | 1（只 `read`，没有写） | 0 |
| dna-insert | `primers.fasta` | 0 | 0（全走 `exec sh -c`） |

与 39557190033 的归因同形：失败不是"写错路径"，而是**交付物从未被写**。`dna-insert` 的 agent 自述（`best-agent-stdout.txt`）逐字承认：`Run status: cancelled (stopped before completion). No deliverable (primers.fasta) was produced.`，并列出"primer 一个都没设计、`oligotm` 只在任意测试 oligo 上跑过、`primers.fasta` 从未创建"。

### 2.4 与 39557190033 的算术并列（只并列，不做因果）

| 格 | 39557190033 的成因（旧归因） | 旧 modelCalls → 本轮 | 本轮事实 |
| --- | --- | --- | --- |
| largest-eigenval | 594s transport 中断；0 次写操作 | 7 → 7 | 0 次 transport；7 次调用 / 368.8s 模型时长；仍 0 次写操作，781.6s 撞预算 |
| extract-elf | 460s transport 中断；0 次写操作 | 7 → 9 | 0 次 transport；9 次调用 / 528.9s 模型时长；仍 0 次写操作 |
| build-cython-ext | 真实改造 pyknotid + 轮次耗尽 | 49 → 39 | 39 次调用、9 次 edit、克隆并构建 pyknotid；829.9s 撞预算（900s） |
| chess-best-move | 预算耗在 pip/apt/cairo 环境 | 27 → 18 | 18 次调用、811.8s 模型时长、0 次写；914.1s |
| code-from-image | 预算耗在 OCR 探索 | 37 → 26 | 26 次调用、901.4s 模型时长、0 次写；1,129.1s |
| gcode-to-text | 预算耗在渲染探索 | 34 → 30 | 30 次调用、10 次写（全是草稿）、0 次交付物；891.9s |
| dna-insert | ΔTm 8.46 °C 超 5 °C 上限 | 21 → 8 | 本轮连 primer 都没设计出来就撞预算；agent 自述为证 |

两轮的 `modelCalls` 差（例：largest-eigenval 7 vs 旧读数 7 附近、dna-insert 8 vs 21）不能读成能力变化：本轮全部在预算处被 stop，模型时长只占墙钟的一部分。

## 3. 结论

- **探针与污染门：本轮不适用/未运行**（公开网络、无 filtered-egress、无 contamination receipt）。因此本记录不声明 "bounded"、不声明 "clean"、不把任何一格读成"模型自己的干净工作"。
- **没有一格失败可以归因于我们的 tool_call 准入或参数限制**：5 次硬拒绝逐条正确（缺必填字段、二进制读、镜像里确实没有 `file`/`cc`/`ld`），且都发生在可继续的中间步；交付物 0 次尝试、0 次写入。
- **这一轮的失败形态是"预算内的交付物缺口"**：7/7 撞预算 stop，6/7 连交付物的写操作都没有；`build-cython-ext` 与 `gcode-to-text` 有真实写入但都不是交付物。
- **传输层本轮未复现故障**：所有 model-outcome 都是 `response`，没有 connection/timeout。1 次尝试/格，不作为修复证据。
- **工具面可诊断性仍有两处登记项**（本轮证据再次出现，但不是失败成因）：`exec` 的 `malformed-input/required command` 与 `not-found` 文案只报事实、不报补救；`apply_patch` 头部文案同理。它们属于"改善 Harness/减少浪费"，不是"误拒"。

## 4. 未验证 / 边界

1. **单次尝试**：每格 1 次，无重跑、无对照臂；不能把任何差值读成因果或能力变化。
2. **没有官方 grader 之外的复核**：verifier 是各任务自带脚本，本轮没有独立复核其判定。
3. **工具调用计数可能低估**：计数来自 evidence 的 terminal snapshot，若某一格在运行中触发 compact，折叠前的行不在 snapshot 里；模型调用数来自 `model-outcome`（完整），工具计数是下界。
4. **没有 per-phase 计时**：`durationMs` 是 pier trial 墙钟，容器 setup、agent、verifier 三段没有分开记录；dna-insert 1,786s 里 agent 只用了 148s 模型时长，其余时间未归因。
5. **候选不含 PR448**（`532224a31` 在构建之后合并），也不含之后的任何提交。
6. **网络与污染**：公开网络下模型可以访问上游（`build-cython-ext` 确实 `git clone` 了 pyknotid 官方仓库，那是该任务取源的一部分）；本轮没有污染门，所以不声称这些读数可用于能力比较。
7. **冻结清单被临时改写**：只为本地校验/运行，运行结束已恢复；`git status` 为空。任何把本轮当作"官方 65235a822 读数"的用法都是错的。
