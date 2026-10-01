# FrontierHarness Eval v1.0 — best-agent（deepseek-v4.1-flash）与官方榜同款 cost/speed 对比图（2026-10-01）

本文件记录用户 2026-10-01 要求的产出：把 **run 36711152110（best-agent / deepseek-v4.1-flash max）** 的结果，与 **FrontierHarness 官方榜**上各 harness 的跑分放在同一套坐标里，生成官方站上同款的两种视图——**cost vs pass rate** 与 **speed vs pass rate**。

## 交付物

| 文件 | 内容 |
| --- | --- |
| `leaderboard-comparison-cost-vs-pass-rate.png` | cost vs pass rate（官方 12 配置 + 本次结果；2300×1320，暗色主题、橙色 Pareto 线） |
| `leaderboard-comparison-speed-vs-pass-rate.png` | speed vs pass rate（同上，横轴 = 成功任务中位耗时） |
| `leaderboard-comparison-deepseek-v4.1-flash.json` | 两者共同的机器可读数据集：本次结果的三个指标 + 官方 12 行 + 判定/成本口径与来源 |
| `leaderboard-official-v1.0-k3.json` | 官方榜快照（12 配置，来源 `results/eval-data.json`，`generated_at 2026-08-22T16:04:57Z`） |
| `leaderboard-pricing-deepseek-v4.1-flash.json` | 本次结果使用的价目表（DeepSeek 公开价，非峰时段），含峰时 2× 敏感度说明 |

复现命令（图表脚本是 python；只需 `python3` + `matplotlib`，例如
`python3 -m venv .venv && .venv/bin/pip install matplotlib`，本仓库其他部分仍是 node）：

```bash
node scripts/frontier-harness-comparison.mjs \
  --record docs/benchmarks/history/frontier-harness/20260930T115155Z--36711152110.json \
  --recovery docs/benchmarks/history/frontier-harness/20260930T183206Z--36759265603.json,docs/benchmarks/history/frontier-harness/20260930T194234Z--36767542570.json \
  --pricing docs/benchmarks/history/frontier-harness/leaderboard-pricing-deepseek-v4.1-flash.json \
  --official docs/benchmarks/history/frontier-harness/leaderboard-official-v1.0-k3.json \
  --readingBasis "<见下文的读数基准原文>" \
  --out docs/benchmarks/history/frontier-harness/leaderboard-comparison-deepseek-v4.1-flash.json
python3 tools/frontier-harness-comparison/chart.py --dataset <上一步输出> --view cost  --out ...-cost-vs-pass-rate.png
python3 tools/frontier-harness-comparison/chart.py --dataset <上一步输出> --view speed --out ...-speed-vs-pass-rate.png
```

## 本次结果（run 36711152110 + 同候选 recovery，读数基准见下）

| metric | value |
| --- | --- |
| cells / verdicts | **30 / 30**（3 个无判定 cell 已由 recovery 36759265603 + 36767542570 全部填补） |
| passed / failed | **23 / 7** |
| **pass rate** | **76.7%**（23/30） |
| **cost per pass** | **$0.1462**（全部 30 个 cell 的成本 ÷ 23 次通过；成本覆盖 30/30） |
| 同一批 token 换官方价目表 | **$7.19**（仅作口径分离，不是账单） |
| **median time per successful task** | **403.5s（6m 44s）** |
| tokens | 输入 385,893,514（其中 380,213,120 = 98.5% 命中缓存）/ 输出 2,281,493 / 2,249 次调用 |

对比：源 run 未修复读数（27 个有效 cell）为 23/27 = 85.2%；把 3 个被环境杀死的 cell 按用户政策重跑后，三题都是 **failed**（expr-try-catch-errors f2p 78/79、katex f2p 0/94、python-statemachine f2p 70/72），所以**通过数仍是 23，分母补齐到 30**，最终读数为 76.7%。

## 官方榜（同一次快照，12 配置；模型 = Kimi K3）

| harness | pass rate | cost per pass | median time per successful task |
| --- | --- | --- | --- |
| Codex | 66.7% | $3.47 | 6m 43s |
| DSH Creator | 63.3% | $3.28 | 6m 44s |
| Claude Code | 63.3% | $18.34 | 9m 38s |
| Pi | 60.0% | $2.43 | 7m 33s |
| DSH PTC | 60.0% | $4.58 | 7m 44s |
| DSH Standard | 60.0% | $3.46 | 6m 17s |
| Oh My Pi | 56.7% | $4.75 | 6m 46s |
| Kimi Code | 56.7% | $3.65 | 7m 56s |
| DSH Minimal | 56.7% | $4.72 | 5m 41s |
| Exo Harness | 53.3% | $1.05 | 6m 17s |
| OpenCode | 50.0% | $3.24 | 6m 27s |
| Hermes | 50.0% | $2.90 | 6m 58s |

官方口径（写进快照文件、图表按同一口径复算）：`pass rate = 通过 cell / 30`；`cost per pass = 全部 30 个已知成本 cell 的成本之和 ÷ 通过数`（官方字段 `effective_cost_per_pass`，网站横轴标题写作 "Median cost per task"，博客表格称 "Median cost per pass"）；`speed = 成功 cell 的中位墙钟秒数`（官方字段 `median_duration_seconds`）。官方成本用的是**冻结价目表** `kimi-k3-2026-08-20`（$3.00 新输入/写缓存、$0.30 读缓存、$15.00 输出每百万），不是实时账单。

## 必须一起读的边界（图上也有文字说明）

1. **模型不同**：官方场次全部是 Kimi K3；本次是 deepseek-v4.1-flash。因此这不是「harness 对比」，而是「把我们的结果摆在官方场次旁边」。图上我们的点是橙色描边星形 + 独立标注，**不进入官方排名、不参与 Pareto 线**。
2. **运行时不同**：官方全部在 Runta 的 golden checkpoint 上（每次 fresh restore、同 vCPU/内存/磁盘）；本仓库是 GitHub-hosted runner 上的诊断自跑。`docs/benchmarks/history/frontier-harness/*.json` 里每一份报告都带同一句结论：**不可与 frontierharness.org 榜单比较**。
3. **价目表不同**：成本这一列混了**两张价目表**——Kimi K3（官方）与 DeepSeek V4.1 Flash（本次，非峰时段 $0.15 新输入 / $0.003 读缓存 / $0.60 输出每百万；无缓存写入费；峰时段 ×2）。同一批 token 在官方价目表上是 $7.19/pass（图中空心星，虚线连接到我们的点），这条口径清晰地说明：**我们成本更低主要来自厂商单价便宜，不是 token 花得少**（我们输入 token/pass 约 16.8M，其中 98.5% 是缓存读）。
4. **本次读数是一个「修复读数」**：源 run 的冻结报告保持原样（3 个 error cell、`verdicts.complete` failed、**passAt1 仍为 null**，它自己的 27 个有效 cell 是 85.2%）。按用户 2026-10-01 的政策——「环境和上游繁忙失败的任务，重跑仍然是公平的，可以作为正确的结果」——把 3 个无判定 cell 用同候选 recovery 补上（清单 `config/frontier-harness-recovery-36711152110.json` 与 `...-second.json`），得到 30/30 判定与上面的 76.7%。这两个数字（85.2% / 76.7%）是同一批数据的两种口径，本文件与图上都按 30 cell 口径呈现。
5. **两张图渲染后的机械检查**：2300×1320、暗色底、橙色 Pareto 线与标记像素均存在（脚本化检查）；本记录不声称对图做过分辨率级别的人工目视审阅。

## 公平性不变量（为什么这个「修复读数」不影响公平）

用户 2026-10-01 的政策是「环境与上游繁忙导致的失败可以重跑」，同时要求**不能影响 benchmark 的公平**。本次读数满足以下不变量，每一条都可从冻结证据机械核查：

1. **每个 cell 恰好一次评分尝试**。27 个已有效 cell 沿用源 run 的那一次尝试；3 个被填补的 cell 在源 run 里**完全没有 attempt**（没有 `model-request`、没有 `jobs/<task>/.../agent/` 目录、没有 `best-agent-evidence.jsonl`、没有 usage 块）——补的是「预声明尝试的覆盖」，不是「已判定 cell 的第二次机会」。
2. **没有任何判定被替换或重新解释**。recovery 只写它自己那 3 个 cell；源 run 的 23 个 passed 与 4 个 failed（含 2 个规格缺口）一字未动。对比脚本把这条写成机械约束并有测试覆盖：只有 `disposition=error`（无判定）的 cell 才允许被填补，且只接受带真实判定的 recovery 记录。
3. **没有 evaluator 输出回流到模型**。三题的 recovery 与源 run 一样，官方 verifier 的结果从不进入任何 model attempt。
4. **预算、effort、grader 全部未变**。`fh_agent_timeout_multiplier=1`、`fh_reasoning_effort=max`、同一 pier pin、同一语料、官方 verifier 仍是唯一评分者；候选源码 commit 与源 run 相同（`cf29eea8`）。
5. **`passAt1` 仍为 null**。源 run 的冻结报告与哈希未改，recovery 从不并入任何 formal run 去产生 pass@1；本文件与图上呈现的 76.7% 是**用户政策下的对比读数**，不是可发布的 pass@1。
6. **每一次派发都先冻结清单再派发**：`config/frontier-harness-recovery-36711152110.json`（run 36759265603）与 `config/frontier-harness-recovery-36711152110-second.json`（run 36767542570），清单写明准入类别、范围、边界（该 cell 的最后一次尝试）与读法。

## 数据来源与冻结时间

- 官方：`https://raw.githubusercontent.com/frontier-harness-eval/eval/main/results/eval-data.json`（`generated_at 2026-08-22T16:04:57.538734+00:00`，`model: k3`，360 cells，9 harnesses / 12 configurations），运营方博客 `https://runta.com/blog/introducing-frontierharness-eval/`，榜页 `https://frontierharness.org/`。抓取于 2026-10-01。
- 本次：run 36711152110（`docs/benchmarks/history/frontier-harness/20260930T115155Z--36711152110.json`，sha256 `6beaf87f…`）+ recovery 36759265603（`20260930T183206Z--36759265603.json`，sha256 `69bd960d…`）+ recovery 36767542570（`20260930T194234Z--36767542570.json`，sha256 `de992615…`）。
- 价目表：DeepSeek 公开价页 `https://api-docs.deepseek.com/quick_start/pricing/`（2026-09-10 04:00 UTC 生效）与调价公告 `https://api-docs.deepseek.com/news/news260910`；本次 run 的服务窗口（2026-09-30T11:51:55Z → 13:22:06Z 与 18:32–20:19Z）都落在非峰时段。注意：本次 run 实际经 `dimagent.cn` 中转（dim-oauth），该中转公布的是 Credits 而非美元单价，故本价目表是**采用的公开价基准**，不是该中转的账单。

## 结论

在这次口径统一之后，本 run 的三个可比值是：**pass rate 76.7%、cost per pass $0.1462、median successful time 6m 44s**。其中 speed（6m 44s）与官方场次的中位区间（5m 41s–9m 38s）高度重合；cost 的低值主要由 deepseek-v4.1-flash 的单价（比 K3 便宜 20–100 倍）决定，而不是由更少的 token 决定——这一点由「同 token 换官方价目表 = $7.19/pass」这一条敏感性直接可见（换表后落在官方场次中段偏上）。pass rate 高于官方场次，但**模型不同**，因此它既不构成 harness 之间的比较，也不改变源 run `passAt1=null` 的事实。
