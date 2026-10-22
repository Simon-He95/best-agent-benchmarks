# best-agent 工具 / 提示词 / 准入 / 参数限制：全覆盖处置清单

基线：`Simon-He95/best-agent` @ `6d8f97ed6`（origin/main）。证据来自三份只读审计（工具清点、提示词缺口、回归基线）加 run 39557190033 的 412 次真实 tool 调用。

处置列的含义：
- **改**：有代码证据的缺陷，可验证地减少误拒或改善可诊断性，进入改动批次。
- **暂缓**：缺陷成立，但本次不改（原因逐条写明）。
- **不改**：核对后确认是设计选择，或"改了也不会更好"。
- **已核对无缺陷**：逐条核对过，登记备查。

## 一、从真实 benchmark 取证的项（优先级最高）

| # | 现象 | 代码证据 | 处置 | 批次 |
| --- | --- | --- | --- | --- |
| E1 | `exec` 的 args 里出现 shell 管道/`&&` 时，二进制把整串当文件参数，报 `No such file or directory`；模型无法得知"本工具无 shell，需用 `sh -c`"。run 中 extract-elf 2 次、meriyah 1 次 | `capability-builtin-tools/src/index.ts:1116`（只说 not a shell）、`:1123`、`:1824-1847`（canonicalizer 只校验 NUL/Unicode/字节）；`workspace-tools.ts:67-71` 明确禁止全局点名 shell | **改（文案已合并）** | 3 — PR #440、spec 426。**不做拒绝**：`grep -F 'a\|b'`、`make make` 是合法 literal argv，按元字符拒绝会造出新的误拒 |
| E2 | `args[0] === command` 时进程照跑（`readelf readelf -a`），退出码 1 但已部分成功，模型被误导 | `capability-builtin-tools/src/index.ts:1122`（有禁令，无诊断） | **改（后果已写明）** | 3 — PR #440。**不做拒绝**：`make make`（target 名等于命令名）、`grep grep file` 都合法 |
| E3 | 缺 `command` 时只回 `malformed-input · required field command`，无 message | `capability-builtin-tools/src/index.ts:1751-1759` | **改** | 1 |
| E4 | `write{path:"."}` 等根路径被拒，文案却是"路径语法含反斜杠/URI/控制字符"，而描述里写着 `use "." for the workspace root` | 描述 `:2563-2566`；拒绝 `:1694`、`:2299`、`:2502`；`apply_patch:517` | **改（已合并）** | 1 — PR #439、spec 425 |
| E5 | `write` 回显输入路径拼写（`{"path":"diff.pl"}`），`exec` 回显 `cwd:"."`，`process-start` 完全不回显 cwd | `workspace-tools-backend:238/281/362`；校验器强制 `value.path === input.path`（`capability-builtin-tools:1922`）；`external-process-service:841` | **改（移出批次 4，单独成批）** | 5 — 回显解析后的绝对路径要改 known payload 形状（新增字段）+ 三处 `value.path === input.path` 等值断言 + backend 生产侧；run 39620264048 的八格证据里没有一次路径或 cwd 误用，收益无法由证据支撑 |

## 二、审计发现但本次不改的项

| # | 现象 | 代码证据 | 处置 | 原因 |
| --- | --- | --- | --- | --- |
| D2 | MCP 任一非文本 content block 让整次调用变 `unknown/malformed`，文本一起丢 | `mcp-application:622`、`mcp-bindings:233/260/239` | 暂缓 | 需要改 outcome schema 与 `additionalProperties:false`，且本 benchmark `--tool-exclude network`、不绑 MCP，零影响；单独批次做 |
| D3 | `view_image` 分析文本 > 32,768 B 整条被静默丢弃 | `capability-image-understanding:335` + `v3/src/effect-runner.ts:449` | 暂缓 | 图像工具在本 benchmark 被排除；修复涉及截断语义 |
| D4 | `workflow-save` 把图校验的精确错误吞成裸 `malformed-input` | `v3-workflow-codec.ts:29`、`v3-workflow-graph-ledger.ts:1903` | 暂缓 | 纯文案接回，风险低；与 workflow 相关 spec 一起改更合适 |
| D5 | 从未 read 就 `write` 既有文件时报"内容已被改过"（假因） | `v3-workspace-read-receipts.ts:222`、`workspace-tools-backend:444`、`:100` | 暂缓 | 文案改动会触发多处精确断言；run 中未出现 |
| D6 | `read` 的 262,144 输出上限与 64 MiB 硬上限均未告知，`too-large` 三种上限共用一句文案 | `workspace-tools-backend:95/1023/1086/1774` | 暂缓 | 纯文案；与批次 1 同类但涉及 `mapFsError` 全分支，分开做 |
| D7 | `tool_approve.scope` 无 enum，未知值抛异常而非可自纠失败 | `capability-interaction-tools:207`、`v3-task-session-service.ts:2169` | 暂缓 | benchmark 不含交互工具；需要与服务层共享词表 |
| D9 | `process-read` 的 `stdoutDroppedBytes` 在 pipe/durable 两种 sink 下语义不同，且无截断标志 | `external-process-service:1554/1577` | 暂缓 | 需要 ~4.3× 转义膨胀才可达，run 中未出现 |
| D10 | `generate_image`/`view_image` 的 canonicalize 失败是裸 `malformed-input` | `capability-image-generation:229/347`、`capability-image-understanding:151` | 暂缓 | 同 D3，图像工具不参与本 benchmark |
| D12 | `search` 默认 `maxResults=100` 未在描述声明 | `capability-builtin-tools:1668` | 暂缓 | 低影响，随批次 1 的文案改动一起做更省 |
| D13 | `apply_patch` 顶层 status 恒 `succeeded`，即使全部文件失败 | `capability-apply-patch:341` | **需先确认** | 在 run 39557190033 中 build-cython-ext 有一次 `apply_patch` 失败（无 path）；先复现该 closure 实际形状再定 |
| D14 | `subagent-*`/`automation-*`/`thread-*` 的失败 payload 只有 `{code}`，无 message | `v3-subagent-tool.ts:1169`、`v3-automation-tool.ts:487` | 暂缓 | 词表较多，单独批次 |
| D15 | 结构化文件工具从不回显解析后的绝对路径（与 E5 同源） | 同 E5 | 并入 E5 | — |
| B1 | 模型可见文本中没有任何一句说明"管道/重定向/`&&` 该用 `sh -c`" | 全仓 0 处；`workspace-tools.ts:67-71` 的设计约束 | **改（已合并）** | 3 — PR #440：按冻结 policy+alias 集投影；`path` 点名 `sh -c`，`catalog` 点名实际承认的 shell alias，词表外的 shell 只给条件式补救，不断言"本组合没有 shell" |
| B2 | `exec` 从未用散文说明 `command` 必填 | `capability-builtin-tools:1130-1140` | **改** | 与 E3 同批 |
| B3 | 文本没有说"相对路径解析到 workspace root" | `:2565-2566`；根只出现在 external context（非权威块） | **改（已合并）** | 4 — PR #441、spec 427：八个结构化文件工具都补 `a relative path is anchored at the workspace root, not at any exec cwd` |
| B4 | `process-start` 两种策略的 cwd 根说明不对称 | `capability-process-tools:1028/1030-1031` | **改（已合并）** | 4 — PR #441、spec 427：两种 cwd policy 都陈述同一句锚，只有 sandbox-backed 那支仍说"检查解析后的目录" |
| E6 | `describe("Path")` 对 `write`／`edit`／`remove`／`apply_patch` 也说 `use "." for the workspace root`，而这四个工具的准入拒绝根 | `capability-builtin-tools` 的 `pathDescription` 单点投影 + `isWorkspacePath(".", false) === undefined`；实测：同一次 `describe` 既喂接受根的 `list` 也喂拒绝根的 `write` | **改（已合并）** | 4 — PR #441（merge `4d708d03a`）、spec 427：`describe(subject, admitsRoot)`，拒绝根的四者改为 `"." names the workspace root and is not an accepted path` |
| E7 | LSP 四个工具的路径句从不把 `"."` 说成根的拼写，但 `path:"."` 仍以 `invalid` 闭合 | `capability-code-intelligence-tools:177-183`（`PATH_NOTE`）与 `safePath:471`（拒绝 `.` 组件） | 暂缓 | 现状不构成"描述邀请、准入拒绝"（`PATH_NOTE` 只说 `"."` 先归一化、结果不得含 `.` 组件）；若要补锚句单独成批 |
| D11 | `automation-*.stopAt` 拒绝 RFC 3339 合法的 `Z` 后缀 | `v3-automation-tool.ts:78-79`、`:204` | **不改（更正）** | 本条审计结论有误：合同明确要求显式 numeric offset（`docs/product-v3/automation.md:61`「RFC 3339 values require an explicit numeric offset」），工具描述与拒绝文案都逐字这么说。RFC 3339 允许 `Z`，但产品合同把它窄化成必须带偏移量，`Z` 被拒是设计选择，不是缺陷。既有测试 `apps/cli/test/v3-automation-tool.test.ts:305` 正是钉住这一点。要接受 `Z` 必须先改合同，不是一行正则 |

## 三、已逐条核对、未发现缺陷

`todowrite`、`now`、`list`、`stat`、`mkdir`、`remove`、`lsp-goto-definition`、`lsp-find-references`、`lsp-diagnostics`、`lsp-symbol-search`、`memory-write`、`compact_start`、`compact_status`、`ask_user`、`web_fetch`、`web_search`、`thread-read`、`workflow-start`、`subagent-result`，以及 MCP **输入侧**校验。

## 四、批次划分与验收

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| 1 | E4（root 拒绝文案） | **已合并**：PR #439（merge commit `cfc77d75a`），spec 425。red 2 failed / 112 passed，green 324 passed；共享套件 1551 passed / 1 skipped。CI 的 `Linux Sandbox Acceptance` 因账号计费未启动（非代码原因），仓库无分支保护，按既有惯例合并 |
| 2 | ~~D11（`stopAt` 接受 `Z`）~~ **取消** | 经合同核对不是缺陷（见 D11 行）：合同要求显式 numeric offset，`Z` 被拒是设计选择。接受 `Z` 需先改合同，不在本清单范围 |
| 3 | E1、E2、B1（args 里的 shell 元字符 / `args[0]===command`） | **已合并**：PR #440（merge commit `bf1b85952`），spec 426。文案按冻结 policy+alias 集投影；**不新增拒绝**（合法 literal argv 反例）。red 1 failed / 17 passed，green 325 passed；共享套件 1612 passed / 1 skipped；`test:cli` 6270 passed / 14 skipped。唯一 BUG 级 review finding（`--exec-alias fish` 让"本组合不承认任何 shell"变成假话）已修 |
| 4 | E6、B3、B4（路径句只广告自己的准入 / 相对路径锚 / 两种 cwd policy 对称） | **已合并**：PR #441（merge commit `4d708d03a`），spec 427。red 1 failed / 17 passed；green 三包 368 passed；每批必跑 `typecheck`／`test:v3` 367／`test:model-binding-ai-sdk` 339／`test:workspace-tools-backend` 85／`test:capability-builtin-tools` 266／`test:application-protocol` 74／`test:process-tools` 109／`test:context-management` 88／`test:v3-thread-store` 490／`test:apply-patch` 62／`test:cli` 6270 passed / 14 skipped 全 `exit 0`。两轮独立 review 共抓到 3 个 BUG（审计快照 `remove` 行未按最终代码重生成、快照 `exec` 两行回退成 426 之前文案、spec 表格把根拒绝写成语法句），全部修好后以"重跑 audit 后工作树干净"证明快照可由源码重现 |
| 5 | E5、D2、D3、D4、D6、D14、E7 | 待开始 |

### 批次 1 的独立 review 结论与处置

review 提出两条阻断/三条建议，全部采纳或明确登记：

| finding | 处置 |
| --- | --- |
| `"/"` 是**文件系统根**，不是工作区根；初版文案与新测试把它叫成 workspace root | **已修**：区分两种根，`"."`/`"./"`/`"src/.."` 给 workspace-root 文案，`"/"`/`"//"` 给 filesystem-root 文案，测试分别断言 |
| 文案说 "name a file or directory inside it"，但 write/edit/apply_patch 只接受文件 | **已修**：改为 "name a file inside it" |
| 依赖"`allowRoot` 只影响根"这条跨包未文档化不变式 | **已修**：改成与 `canonicalRemove` 同形的"一次 `canonicalize(…, true)` + 显式判根"，不再依赖该不变式 |
| `exec` 描述新增的"command 必填"句与键集句、args 句重复 | **已撤回**：本批不含该句；真正的缺口是 `required` issue 没有 message，而那是共享 wire 类型 |
| 三处同类文案（builtin write/edit、remove、apply_patch）不统一 | **登记，本批不改**：统一需要 domain 暴露"是否根"，属接口变更，另批 |
| `describe()` 仍对 `allowRoot=false` 的工具说 `use "."` | **登记**：这是比文案更本质的修法（减少无效调用而非把错误说好听），需改 `describe` 签名与钉住描述的测试，单独成批 |

### 因 review 而从批次 1 移出的项

- **E3（`required field command` 无 message）**：`ToolInputIssueV1`（`packages/application-content/src/index.ts:209`）的 `required` 变体是 `{code, field}`，加 message 需放宽共享 wire 类型并同步 codec/展示测试。单独成批。

**每批必跑**（按耗时递增）：`pnpm typecheck` → `pnpm test:v3` → `pnpm test:model-binding-ai-sdk` → `pnpm test:workspace-tools-backend` → `pnpm test:capability-builtin-tools` → `pnpm test:application-protocol` → `pnpm test:process-tools` → `pnpm test:context-management` → `pnpm test:v3-thread-store` → 30 个 targeted CLI 文件 → `pnpm test:cli`。

**每批必须复核不被破坏的契约面**（PR296 相关）：
- provider-wire 上下文估算：`model-binding-ai-sdk:819/902-912/1205-1217/1398-1412/1522-1533` + `input-window.test.ts`、`wire-projection.test.ts`
- host transcript 估算与 auto-compact 85% 触发：`auto-compact.ts:178-315`、`transcript-tokens.ts:36-92`、`auto-compact-turn.ts:583-612`
- compact fold 的 96k/8k/80k/8,192 字节切片：`v3-run.ts:2859-2943`（tool entry 不入 fold source，新增 payload 字段不影响分类，但改 error 文案会）
- 源错误与续跑：`kernel/transition.ts:617-625/1040-1050/1084-1100`、`kernel/data.ts:454-461`、`native-runtime-bridge.ts:703-710/6796-6903`
- 新增 failure code 会扩 closed union 并阻止 connection retry：`kernel/data.ts:56-86`、`native-runtime-bridge.ts:703-710`

## 五、一条不属工具契约但影响最大的事实

run 39557190033 的 8 个失败格里，6 格出现 provider `transport` 故障，累计吞掉 **2,246 秒**预算（largest-eigenval 一格 594s / 900s）。这是本轮最大的单一可回收项，但它是传输层问题，不属于本清单的工具契约范围，需要单独判定是否允许"剩余预算内续跑"而不违反 benchmark 的单次尝试语义。

复现批次（run 39620264048，`20261021T164650Z--39620264048.md`）在同一 8 格上再次记录到 **7 次 transport 中断 / 1,181 秒**，并把它钉成可机械核对的事实：八格的 `exec` cwd 只有默认 `.` 与 workspace 内子目录，非成功闭包只有 3 次硬拒绝（`exec` 两次 `not-found`：`file`、`xxd` 不在冻结 PATH；`write` 一次 `conflict`），没有一次 `malformed-input`／`outside-workspace`／`cwd-unavailable`／`permission-denied`；五格 verifier 报"文件不存在"的交付物路径在整格轨迹里**从未被提到**。因此"文件不存在 = 写错路径 / cwd 搞错"这一假设被证据否定，本清单里与路径有关的两项（E4/E6）属于"描述与准入不一致"的可诊断性问题，不是这些失败的成因。

### 批次 3+4 的实测效果（run 39700728172，`20261022T024432Z--39700728172.md`）

同 8 格、每格一次尝试，候选 `4d708d03a`（0.0.15-beta.1）相对上一臂的唯一差异就是批次 3 与批次 4 的文案。按 callId 去重的同一套度量：

| 指标 | 基线 39620264048（未修） | 本次 39700728172（含 3+4） |
| --- | --- | --- |
| 契约形状浪费 | **10** | **1** |
| shell 操作符当字面 argv | 8（全在 meriyah） | 1（build-cython-ext） |
| `args[0]` 重复命令名 | 2（build-cython-ext） | **0** |
| 显式 `sh -c` 使用 | 37 / 195 次 exec（19%） | **174 / 253 次 exec（69%）** |
| 硬拒绝 | 3（全部正确） | 6（全部正确，无 `malformed-input`） |

这是本清单里**第一个被真实 run 观测到的收益**，但它的构成必须拆开说，否则会被误读：

- 基线的 10 次里 **8 次全在 meriyah**，而 meriyah 这一次尝试恰好是被污染的那格（见下）——模型当时在做上游考古，不是在做实现，所以"8 → 0"**不能**当作干净证据。
- 干净部分的证据是另外 7 格：浪费 **2 → 1**，其中 `args[0]` 重复命令名 **2 → 0**（build-cython-ext），build-cython-ext 本身新增 1 次 shell 操作符当 argv（`grep -rhE ^import |^from …`）。
- 全局 `sh -c` 使用率 19% → 69% 是形状层面的强信号，且与 spec 426 写的那句补救一致；但同样的 7 格里 build-cython-ext 从 0/32 变成 12/37、code-from-image 34/34 全用 shell，说明这是"模型学会了用 shell 跑一行"，不等于每一种形状都消失。

所以准确的说法是：**spec 426 的补救句被采纳了（`sh -c` 使用率显著上升），`args[0]` 重复命令名在干净格上消失；但"契约形状浪费 10 → 1"这个总数不能单独引用，因为它的大头落在被污染的那格。** 另两条限制同样必须一起引用：样本是**每格一次尝试**，只能说明"该形状会／不会复现"，不能当比例；处置（1 → 2 passed）不能归因于这批文案——新增的 build-cython-ext 是模型自己补了 planarity 兼容层。

同一臂还暴露一个与本清单无关但更严重的问题：meriyah 那一次尝试**读了上游答案**（克隆 meriyah 仓库、`git show d40161d`、`npm pack meriyah@7.4.0`、取 test262 的官方用例），且因未 commit 导致 `model.patch` 为 0 字节。该格因此标记为 `contaminated-by-upstream-access`，其 f2p 不可与基线的 48/49 相减；基线那一遍扫描未发现同类访问，故仍是唯一未被污染的 meriyah 读数。
