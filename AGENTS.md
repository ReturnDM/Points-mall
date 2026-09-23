# 积分商城 · Agent 工作约定

本项目已不再使用管家库里的 points-ledger skill（2026-09-23 移除）。在本项目工作时，Agent 直接按下述接口自行完成记账，无需加载任何 skill。

## 数据接口

- **数据目录**：环境变量 `POINTS_DATA_DIR` → 项目根 `config.local.json` 的 `dataDir`；都没有就停下让用户配置，不猜路径。当前为 `D:\Nutstore\积分商城数据`。
- **规则权威文档**：`docs/schema.md`（数据 schema）与 `docs/agent-ledger.md`（Agent 记账规范），冲突时以 schema.md 为准。
- **写账前必读**：`tasks.json`（档位与常见事项分值）、`shop.json`（商品）。

## 记账要点（细节以两份 docs 为准）

- 流水（`ledger/YYYY-MM/<id>.json`）是唯一事实来源，余额 / 经验 / 等级全部由流水汇总，不存总数文件。
- 意图分流：earn / adjust / redeem_physical / redeem_voucher / use_voucher / recycle_voucher；改账、撤销只追加 adjust 记录，永不删改历史文件。
- 写入必须原子：先写 `<id>.json.tmp` 再改名；id 格式 `YYYYMMDD-HHmmss-xxxx`，time 用带时区 ISO 8601。
- 无固定分值事项：主模型与 Jev（TypeSafe）各判一次，差 ≤50% 取平均；Jev 不可用则自行定档并在 note 标注「未经 Jev 复核」。
- 每次写账后回报：本次积分/经验变动、当前余额（≈¥，汇率 20 分 = 1 元）、等级与升级进度（第 N→N+1 级需 `100 + 10×(N−1)` 经验）。
