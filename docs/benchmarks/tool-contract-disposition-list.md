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
| E1 | `exec` 的 args 里出现 shell 管道/`&&` 时，二进制把整串当文件参数，报 `No such file or directory`；模型无法得知"本工具无 shell，需用 `sh -c`"。run 中 extract-elf 2 次、meriyah 1 次 | `capability-builtin-tools/src/index.ts:1116`（只说 not a shell）、`:1123`、`:1824-1847`（canonicalizer 只校验 NUL/Unicode/字节）；`workspace-tools.ts:67-71` 明确禁止全局点名 shell | **改** | 2 |
| E2 | `args[0] === command` 时进程照跑（`readelf readelf -a`），退出码 1 但已部分成功，模型被误导 | `capability-builtin-tools/src/index.ts:1122`（有禁令，无诊断） | **改** | 2 |
| E3 | 缺 `command` 时只回 `malformed-input · required field command`，无 message | `capability-builtin-tools/src/index.ts:1751-1759` | **改** | 1 |
| E4 | `write{path:"."}` 等根路径被拒，文案却是"路径语法含反斜杠/URI/控制字符"，而描述里写着 `use "." for the workspace root` | 描述 `:2563-2566`；拒绝 `:1694`、`:2299`、`:2502`；`apply_patch:517` | **改** | 1 |
| E5 | `write` 回显输入路径拼写（`{"path":"diff.pl"}`），`exec` 回显 `cwd:"."`，`process-start` 完全不回显 cwd | `workspace-tools-backend:238/281/362`；校验器强制 `value.path === input.path`（`capability-builtin-tools:1922`）；`external-process-service:841` | **改** | 3 |

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
| B1 | 模型可见文本中没有任何一句说明"管道/重定向/`&&` 该用 `sh -c`" | 全仓 0 处；`workspace-tools.ts:67-71` 的设计约束 | **改（条件投影）** | 必须与 policy 允许集一致，不能全局写死；与 E1 同批 |
| B2 | `exec` 从未用散文说明 `command` 必填 | `capability-builtin-tools:1130-1140` | **改** | 与 E3 同批 |
| B3 | 文本没有说"相对路径解析到 workspace root" | `:2565-2566`；根只出现在 external context（非权威块） | **改** | 与 E5 同批（回显 + 一句说明） |
| B4 | `process-start` 两种策略的 cwd 根说明不对称 | `capability-process-tools:1028/1030-1031` | **改** | 与 E5 同批 |
| D11 | `automation-*.stopAt` 拒绝 RFC 3339 合法的 `Z` 后缀 | `v3-automation-tool.ts:76/197` | **改** | 标准合规问题，一行正则；本清单编写期间我自己也必须回避这个形状 |

## 三、已逐条核对、未发现缺陷

`todowrite`、`now`、`list`、`stat`、`mkdir`、`remove`、`lsp-goto-definition`、`lsp-find-references`、`lsp-diagnostics`、`lsp-symbol-search`、`memory-write`、`compact_start`、`compact_status`、`ask_user`、`web_fetch`、`web_search`、`thread-read`、`workflow-start`、`subagent-result`，以及 MCP **输入侧**校验。

## 四、批次划分与验收

| 批次 | 内容 | 验收 |
| --- | --- | --- |
| 1 | E3、E4、D11、B2 | 新增/修改的断言级测试：`"."` 被拒时文案指向"根不可写"；`stopAt` 接受 `Z` 与 `+08:00` 等价；缺 `command` 的 issue 带 message |
| 2 | E1、E2、B1 | 含 `\|`/`&&`/`;`/`$(` 的 args 返回具名诊断且**不启动进程**；`args[0]===command` 返回具名诊断；文本按 policy 条件投影 |
| 3 | E5、B3、B4 | payload 新增 `resolvedPath`/`resolvedCwd`；断言相对输入得到 `resolve(root, path)`；预算与 compact 边界重跑 |
| 4 | D2、D3、D4、D6、D14 | 各自单测；`unknown/malformed` 不再吞掉可表达的错误 |

**每批必跑**（按耗时递增）：`pnpm typecheck` → `pnpm test:v3` → `pnpm test:model-binding-ai-sdk` → `pnpm test:workspace-tools-backend` → `pnpm test:capability-builtin-tools` → `pnpm test:application-protocol` → `pnpm test:process-tools` → `pnpm test:context-management` → `pnpm test:v3-thread-store` → 30 个 targeted CLI 文件 → `pnpm test:cli`。

**每批必须复核不被破坏的契约面**（PR296 相关）：
- provider-wire 上下文估算：`model-binding-ai-sdk:819/902-912/1205-1217/1398-1412/1522-1533` + `input-window.test.ts`、`wire-projection.test.ts`
- host transcript 估算与 auto-compact 85% 触发：`auto-compact.ts:178-315`、`transcript-tokens.ts:36-92`、`auto-compact-turn.ts:583-612`
- compact fold 的 96k/8k/80k/8,192 字节切片：`v3-run.ts:2859-2943`（tool entry 不入 fold source，新增 payload 字段不影响分类，但改 error 文案会）
- 源错误与续跑：`kernel/transition.ts:617-625/1040-1050/1084-1100`、`kernel/data.ts:454-461`、`native-runtime-bridge.ts:703-710/6796-6903`
- 新增 failure code 会扩 closed union 并阻止 connection retry：`kernel/data.ts:56-86`、`native-runtime-bridge.ts:703-710`

## 五、一条不属工具契约但影响最大的事实

run 39557190033 的 8 个失败格里，6 格出现 provider `transport` 故障，累计吞掉 **2,246 秒**预算（largest-eigenval 一格 594s / 900s）。这是本轮最大的单一可回收项，但它是传输层问题，不属于本清单的工具契约范围，需要单独判定是否允许"剩余预算内续跑"而不违反 benchmark 的单次尝试语义。
