# iBench 41557196637：终态与套餐中断分离

原始运行：[41557196637](https://github.com/Simon-He95/best-agent-benchmarks/actions/runs/41557196637)，冻结 head2bdf61a。11批44题均已结束；最后聚合完成于2026-11-03北京时间12:50。此轮是solver-only，官方评分未运行，passRate仍为null。汇总pending是未评分，不能理解为未启动。

| 实际 solver 终态 | 题数 | 证据含义 |
| --- | ---: | --- |
| completed | 15 | CLI正常结束，不等同修复通过 |
| cancelled/stopped | 25 | 预算停止，不能归因套餐到期 |
| failed/model-failure，HTTP402 | 4 | provider明确insufficient_balance |
| 真正未进入推理 | 0 | 44题均已有成功模型响应 |

25道停止题的agent阶段wall为3513.57–3517.17秒，中位3514.27秒，约58分34秒；与3600秒总预算扣除现有收尾预留相符。CLI返回exit1/signal=null，最终Git收尾均exit0。subagent wait aborted等停止时尾部观察不能单独当作网络或子代理调度根因。逐命令耗时缺少独立entry/end，不能用模型gap断言某个验证脚本消耗多少分钟。

套餐中断的4题共有5条402响应记录；它们已经运行并产生成功推理，不是未开始：

| 任务 | agent wall（分钟） | 成功模型响应（root+child） | 原冻结补丁字节 |
| --- | ---: | ---: | ---: |
| `grokability/snipe-it#18872` | 30.8 | 389 | 0 |
| `netbox-community/netbox#23161` | 37.6 | 244 | 0 |
| `netbox-community/netbox#23190` | 32.5 | 192 | 0 |
| `owncloud/ocis#12753` | 25.8 | 159 | 3992 |

中断发生在北京时间约12:48–12:49，source诊断为HTTP402/insufficient_balance。服务端给出的直接原因是余额不足；套餐到期是用户提供的账户状态，不能将其改写成线路、CPU或内存故障。上述4题保留原失败、全部轨迹和部分补丁；其余25预算停止题不纳入这次套餐补跑。

## 保存和验证

11份原始batch ZIP已落盘并匹配GitHub artifact digest，逐份SHA收据保存在本地`.tmp/ibench-41557196637/artifact-receipts.json`。从副本读取trial/CLI receipt、诊断、轨迹、补丁；没有改写原归档或verdict。44份JSONL的prefix hash、连续sequence和实际行数对writtenCounts均校验；44个footercomplete=true。44份canonical solver patch均保留：26非空、18空；均有单独SHA256。完整逐题机器记录及原始diagnostic保留本地`.tmp/ibench-41557196637/audit-final.json`。Source/原始构建诊断保持私有。

本轮44题的primary都只有一个Run，未见primary窗口拒绝后的新Session恢复；HTTP记录除200外仅有5次402，没有观察到400/413。此范围不支持把25题预算停止归因auto-compact；没有RSS/CPU采样也不报告资源峰值。CLI未见signal/OOM-kill退出不代表所有验证子进程都没有资源压力。

## 独立补跑（等待账户恢复）

预声明：[4题补跑清单](../config/ibench-billing-interrupted-02d40a08-20261103.json)。仅上述4个billing-interrupted任务，每题最多一次额外solver-only诊断尝试，候选source02d40a083dc3/归档abe5d789…e2847、Flash/high、dimagent、3600秒预算不变。采用新鲜base workspace和storage，不把旧patch/轨迹/诊断作为任务提示，不覆盖旧prediction，不合并成严格pass@1或官方DSH比较。

当前账号不可用，未dispatch补跑，也未用付费推理试探额度。账户恢复后再冻结此manifest的提交并单独选择这4个task id启动；旧轮不会重启，其他40题不重跑。原每小时监控已处于PAUSED，避免重复自动处理已结束运行。

## 逐题快照

| Task | 终态分类 | agent分钟 | 补丁字节 | evidence完整 |
| --- | --- | ---: | ---: | --- |
| `Afilmory/Afilmory#243` | completed | 48.0 | 8524 | yes |
| `Afilmory/Afilmory#274` | completed | 23.2 | 4033 | yes |
| `Dolibarr/dolibarr#39305` | stopped | 58.6 | 0 | yes |
| `Dolibarr/dolibarr#40071` | stopped | 58.6 | 0 | yes |
| `Dolibarr/dolibarr#40681` | stopped | 58.6 | 0 | yes |
| `Dolibarr/dolibarr#40920` | stopped | 58.6 | 4312 | yes |
| `Dolibarr/dolibarr#41125` | stopped | 58.6 | 0 | yes |
| `FreshRSS/FreshRSS#9025` | stopped | 58.6 | 0 | yes |
| `LimeSurvey/LimeSurvey#4254` | completed | 54.1 | 646 | yes |
| `actualbudget/actual#7827` | stopped | 58.6 | 844 | yes |
| `calcom/cal.diy#29544` | stopped | 58.6 | 4770 | yes |
| `discourse/discourse#42435` | stopped | 58.6 | 1676 | yes |
| `discourse/discourse#43076` | stopped | 58.6 | 0 | yes |
| `documenso/documenso#2204` | stopped | 58.6 | 2801 | yes |
| `glpi-project/glpi#24797` | completed | 42.9 | 5819 | yes |
| `glpi-project/glpi#24800` | completed | 57.5 | 6127 | yes |
| `go-gitea/gitea#38329` | stopped | 58.6 | 0 | yes |
| `go-gitea/gitea#38593` | stopped | 58.6 | 0 | yes |
| `go-gitea/gitea#39221` | completed | 40.0 | 2980 | yes |
| `go-gitea/gitea#39285` | stopped | 58.6 | 0 | yes |
| `gristlabs/grist-core#2298` | completed | 23.6 | 3157 | yes |
| `grokability/snipe-it#18872` | billing-interrupted | 30.8 | 0 | yes |
| `hoppscotch/hoppscotch#6155` | completed | 26.6 | 1307 | yes |
| `kimai/kimai#6075` | stopped | 58.6 | 784474 | yes |
| `langgenius/dify#38063` | stopped | 58.6 | 117080 | yes |
| `lobehub/lobehub#17789` | stopped | 58.6 | 0 | yes |
| `makeplane/plane#8600` | stopped | 58.6 | 603494 | yes |
| `makeplane/plane#8759` | stopped | 58.6 | 811 | yes |
| `makeplane/plane#9285` | completed | 18.7 | 927 | yes |
| `metabase/metabase#77898` | stopped | 58.6 | 0 | yes |
| `metabase/metabase#79490` | stopped | 58.6 | 103152 | yes |
| `metabase/metabase#80439` | stopped | 58.6 | 0 | yes |
| `navidrome/navidrome#5706` | completed | 51.2 | 3175 | yes |
| `netbox-community/netbox#23161` | billing-interrupted | 37.6 | 0 | yes |
| `netbox-community/netbox#23190` | billing-interrupted | 32.5 | 0 | yes |
| `openemr/openemr#14233` | completed | 37.1 | 1619 | yes |
| `oppia/oppia#27320` | completed | 52.6 | 12761 | yes |
| `oppia/oppia#27464` | completed | 42.0 | 18492 | yes |
| `owncloud/ocis#12753` | billing-interrupted | 25.8 | 3992 | yes |
| `penpot/penpot#10550` | completed | 38.4 | 2431 | yes |
| `penpot/penpot#11427` | stopped | 58.6 | 0 | yes |
| `penpot/penpot#11699` | stopped | 58.6 | 0 | yes |
| `saleor/saleor-dashboard#6868` | stopped | 58.6 | 0 | yes |
| `saleor/saleor-dashboard#6891` | completed | 52.1 | 3189 | yes |

验证：完整npm test279/279 exit0，git diff --check exit0；44份footer expected/written等值，4题补跑集与其余40题互斥且覆盖原44题，候选archive/hash/model/预算保持一致。此验证不发起模型或官方评分调用。
