# run 39557190033 的 8 个 failed 格：tool_call 归因

对象：FrontierHarness Eval v1.0，run [39557190033](https://github.com/Simon-He95/best-agent-benchmarks/actions/runs/39557190033)（candidate `cli-0.0.14-beta.1-5bc13e8-ce25df08d65a`，glm-5.3 / high）加补测 run [39585210102](https://github.com/Simon-He95/best-agent-benchmarks/actions/runs/39585210102) 的 meriyah 格。冻结记录见 `20261021T092902Z--39557190033.json` 与官方读数 `20261021T092902Z--39557190033.official.json`。

判据：只看 8 个格子自己的 evidence（`agent/best-agent-evidence.jsonl`）与 frozen per-task 记录，不用 CI 日志推断替代记录字段。全部 8 格合计 **412 次互不相同的 tool 调用**（按 callId 去重）。

## 结论（一句话）

**8 次硬拒绝全部是工具按设计正确拒绝，没有一次误拒；没有任何一格曾经尝试写入它自己的交付物路径。所以这 8 个失败没有一个是"路径写错 / cwd 搞错 / 被我们的准入层挡掉"造成的。**

它们真实的成因是三类：供应商传输中断吃掉预算、预算在环境准备与探索中耗尽、以及真正的任务难度。

## 一、硬拒绝逐条核对（8/8 正确）

"硬拒绝"指后端在真正执行任何东西之前就拒绝（`malformed-input` / `not-found` / `permission-denied` / `occurrence-mismatch` / `too-large` / `unknown-command` 等）。

| # | 格 | 工具 | code | 模型给的输入 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 1 | build-cython-ext | `edit` | occurrence-mismatch | `expectedOccurrences:2`，实际只有 1 处 | **正确**：模型声明要改 2 处而文中只有 1 处；随后它改成 1 处并成功 |
| 2 | code-from-image | `exec` | not-found | `command:"convert"` | **正确**：镜像里没有 ImageMagick |
| 3 | code-from-image | `exec` | not-found | `command:"tesseract"`（安装前） | **正确**：此时尚未安装 |
| 4 | dna-insert | `exec` | not-found | `command:"python3"` | **正确**：该题镜像按设计是 Perl + oligotm，没有 python3（同一格 `perl`、`oligotm`、`apt-get` 都能解析） |
| 5 | largest-eigenval | `exec` | not-found | `command:"gcc"` | **正确**：镜像无编译器（模型自己随后确认 gcc/cc/clang/tcc/g++ 全无） |
| 6 | meriyah | `exec` | permission-denied | `command:"node_modules/.bin/"` | **正确**：把目录当可执行文件，EACCES |
| 7 | meriyah | `exec` | not-found | `command:"vitest"` | **正确**：vitest 不是全局可执行 |
| 8 | meriyah | `exec` | not-found | `command:"node node_modules/vitest/vitest.mjs"` | **正确**：把整条命令塞进 `command` 一个字段 |

其中 #2、#6、#7、#8 同时暴露一个**模型侧的形状错误**（不是准入层缺陷）：把 shell 串或整条命令放进单个字段。见第三节。

## 二、"文件不存在"类失败：没有一次是路径问题

5 格的 verifier 报"文件不存在"。核对每一格的写操作目标：

| 格 | verifier 要求的交付物 | 该格所有 write/edit/apply_patch 的目标 | 是否曾尝试写交付物 |
| --- | --- | --- | --- |
| chess-best-move | `/app/move.txt` | 6 次，全部 `/app/_analyze.py`、`_identify.py`、`_ascii.py`… 等临时脚本 | **0 次**，全文没有任何调用提到 `move.txt` |
| code-from-image | `/app/output.txt` | 11 次，全部 `/tmp/*.py` 草稿 | **0 次**，无任何调用提到 `output.txt` |
| gcode-to-text | `/app/out.txt` | 12 次，全部 `/app/*.py` 草稿 | **0 次**，无任何调用提到 `out.txt` |
| extract-elf | `/app/extract.js` | **0 次写操作**（整格只有 9 次 exec） | **0 次** |
| largest-eigenval | `/app/eigen.py`（改实现） | **0 次写操作**（只有 read + exec） | **0 次** |

所以："文件不存在"不是写错路径、也不是 cwd 解析到别处——**交付物从未被写过一次**。模型把时间花在分析/探索/装依赖上，直到预算耗尽或被传输中断杀死。

> **2026-10-22 复核（本地重跑，候选 `65235a822`）：** 同一 7 格用当前 main 重放，7/7 仍 failed、7/7 撞预算 stop，但 0 次 transport 故障、5 次硬拒绝逐条正确、交付物仍 0 次尝试。见 [frontier-harness-local-repro-65235a822-20261022.md](frontier-harness-local-repro-65235a822-20261022.md)。该轮没有 filtered-egress 探针与污染门，因此那份记录不声明 bounded/clean。

## 三、33 次"执行后失败"里可归因于工具契约的比例

"执行后失败"= 后端正常启动进程，进程自己以非零退出码结束（不是准入拒绝）。合计 33 次。其中与工具契约形态直接相关的：

| 形状 | 实例 | 后果 | 性质 |
| --- | --- | --- | --- |
| shell 管道/串联塞进非 shell 工具的 args | `exec{command:"od", args:["-c","od -A x -t x1 /app/a.out \| head -80"]}` → `/usr/bin/od: 'od -A x -t x1 /app/a.out \| head -80': No such file or directory`（extract-elf 2 次）；`exec{command:"git", args:["log","--oneline","-3","&&","ls"]}` → `ambiguous argument '&&'`（meriyah） | 浪费一轮，且报错文案让模型以为是文件问题 | **可诊断性缺陷**：报错没有指出"本工具无 shell，请用 sh -c" |
| 命令名重复进 args | `exec{command:"readelf", args:["readelf","-a","/app/a.out"]}` | 退出码 1，但仍打印了 ELF header（部分成功，模型被误导） | **可诊断性缺陷** |
| 解释器与参数混用 | `exec{command:"bash", args:["-m","apt-get","install","-y","libcairo2"]}` → `cannot execute binary file` | 浪费一轮 | 模型侧错误 |
| 省略必填字段 | `exec{args:[...]}` 无 `command` → `malformed-input: required field command`（meriyah） | 浪费一轮 | 准入正确，报错正确 |
| 相对路径写文件后无绝对路径回显 | `write{path:"diff.pl"}` → 返回 `{"path":"diff.pl","bytes":1138}` | 模型无法确认文件落点；本格恰好同 cwd 内 `perl diff.pl` 可用而未出错 | **可观测性缺陷** |

这三条是本次唯一有代码证据、且**可验证地能减少浪费**的工具侧问题。它们在本次数据里**没有直接造成任何一格失败**，但会稳定地消耗轮次，在 900 秒级别的预算里可能就是把格子拖死的边际量。

## 四、必须更正的一处早前读数

上一轮我回答"largest-eigenval 只差 1 µs（26/27）"时，把它读成了"模型几乎做成"。**这个读法是错的。**

该格 **0 次写操作**，`/app/eigen.py` 始终是题目自带的参考 stub（内容就是 `np.linalg.eig` + `argmax`）。verifier 的 27 个用例里，stub 天然通过 26 个（正确性 18 项 + speedup 3–10 共 8 项），只失败 `test_speedup[2]`（2×2 上 stub 26 µs vs 参考 25 µs）。也就是说：

- 26/27 是 **stub 的分数，不是模型的成绩**；
- 那 1 µs 的差是 stub 自身相对参考实现的调用开销波动，与模型能力无关；
- 该格真实状态是"**模型没有产出任何实现**"，原因是 594 秒预算被一次 provider `transport` 故障吃掉（占 900 秒预算的 77%）。

因此第四节标题下的正确读法是：**这一格不是"差一点点"，是"什么都没做"**。

## 五、八格的真实成因

| 格 | dispose | 预算/用时 | 决定性成因 | 差距性质 |
| --- | --- | --- | --- | --- |
| largest-eigenval | failed | 900s / 768s | 594s 传输中断；0 次写操作 | 未实现（stub 26/27） |
| extract-elf | failed | 900s / 793s | 460s 传输中断；0 次写操作 | 未实现 |
| building-cython-ext | failed | 900s / 779s | 真实改造 pyknotid + 轮次耗尽 | 真实难度（扩展未构建） |
| chess-best-move | failed | 900s / 839s | 预算耗在 pip/apt/cairo 环境安装；未写交付物 | 未交付 |
| code-from-image | failed | 1200s / 1171s（撞 run-deadline） | 预算耗在 OCR 探索；未写交付物 | 未交付 |
| gcode-to-text | failed | 900s / 785s | 预算耗在渲染探索；未写交付物 | 未交付 |
| dna-insert | failed | 1800s / 569s（正常完成） | ΔTm = 8.46 °C 超过 5 °C 上限 | 真实领域错误 |
| meriyah | failed | 5400s / 5411s（用满） | f2p 0/49、p2p 51469/51469 | 未实现（无回归） |

供应商 `transport` 故障在 8 格中出现 6 次，累计 **2 246 秒**，是本轮最确定的可回收预算。

## 六、可行动项（进入处置清单）

1. **供应商传输中断**：2 246 秒预算被吞。这不是工具契约问题，但它是本轮最大单一致败因子，值得在 CLI 层评估"传输失败后是否允许在剩余预算内续跑"（需先确认不违反 benchmark 单次尝试规则）。
2. **相对路径/相对 cwd 的绝对路径回显**（可观测性）：`write` 返回 `{"path":"diff.pl"}`, `exec` 返回 `"cwd":"."`。加一个解析后绝对路径字段，让模型能自证文件落点。
3. **非 shell 工具的报错文案**（可诊断性）：当 args 里出现 `|`、`&&`、`>` 等 shell 语法时，报错应指出"本工具无 shell，请用 `sh -c`"，而不是让二进制返回 "No such file or directory"。
4. **`args[0]` 等于 `command`** 时给出明确提示，而不是让进程以退出码 1 部分成功。
5. **交付物意识**：不是工具问题，属提示词/任务理解；这里不改提示词，仅登记。

以上 2–4 需要按 `AGENTS.md` 的合同流程逐批改、跑回归、PR、独立 review 后合并。第 1 项需要先判定它是否与 benchmark 单次尝试语义冲突。
