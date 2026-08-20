# Benchmark Runner 调度与卡死处理协议（2026-08-20 根因分析后）

## 根因（已验证）
- 非代码问题：harness/CLI/benchmark 均正常（#60 16 并发成功跑完为证）
- GitHub Actions **macos-latest runner 免费池紧张**时：job 进入 `in_progress` 但 runner
  在环境准备阶段卡住（无任何日志，含 checkout/setup）——表现为"假 in_progress"
- 多个 run 同时触发（≥2 个 × 高并发）→ 超池 → 后面的 run 排队卡死
- 取消卡死 run 释放槽位 → 其他 run 立即启动（#62 取消 #61 后 4 shard 全起）

## 调度规则（避免超池）
1. **一次只跑 1 个 benchmark run**（串行）——完成后再触发下一个
2. 单 run 并发 ≤ 8（4 shard × concurrency 2）——减少 runner 需求
3. 触发前检查 `gh run list`：有 in_progress 的 benchmark run 时不发新 run

## 卡死判定（可靠信号，非 updatedAt）
1. job `in_progress` 后 **45 分钟**仍无日志（`gh api .../jobs/<id>/logs` 返回
   BlobNotFound / 404）→ 判定 runner 排队卡死
2. 判定后：取消该 run（释放槽位），不要等 2h+ 才发现
3. 取消后观察下一 run 是否启动（释放验证）

## 监控
- 每 20 分钟轮询（wakeup）
- 检查顺序：run 状态 → 完成则解析 → 卡死则按上述判定取消 → 续监控
