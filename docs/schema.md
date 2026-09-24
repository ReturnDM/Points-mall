# 数据 Schema（定稿 v1）

> 单一事实来源是**流水（ledger）**。积分余额、经验、等级、背包全部由流水汇总计算，
> 不另存可被直接改动的总数文件。

## 目录结构

```
<数据目录>/                     # 坚果云同步目录，如 D:\Nutstore\积分商城数据
├── config.json                 # 可选：{ "physicalRate": 25 } 实物汇率（积分/元），缺省 20
├── tasks.json                  # 价目表（档位制）
├── shop.json                   # 商城商品
├── 积分规则.md                  # 专项计分细则（人写人改；与 tasks.json 冲突时以本文件为准）
└── ledger/                     # 每笔流水一个 JSON 文件，文件名 = 记录 id
    └── 2026-02/                # 建议按年-月分目录，也可全部平铺
        └── 20260206-090000-ab12.json
```

> **调整汇率**：只改 `config.json` 的 `physicalRate`，影响之后的实物标价；不追溯历史流水
> （兑换记录里的 `rate` 字段存了成交时的汇率快照）。

## 流水记录（LedgerEntry）

```jsonc
{
  "id": "20260206-090000-ab12",      // 唯一 ID，= 文件名（去 .json）
  "time": "2026-02-06T09:00:00+08:00", // ISO 8601
  "type": "earn",                     // 见下方枚举
  "title": "刷牙",                    // 事项/商品名（展示用）
  "points": 5,                        // 积分变动，正负号即方向
  "exp": 5,                           // 经验变动；仅 earn 与 adjust 冲正非零
  "ref": "20260206-100000-cd34",      // 可选：use/recycle/adjust 关联的原记录 id
  "rate": 20,                         // 可选：兑换实物时的汇率快照（积分/元）
  "note": "早上刷牙，顺手洗了脸"       // 可选：备注/上下文
}
```

### type 枚举与记账规则

| type | 含义 | points | exp | ref |
|---|---|---|---|---|
| `earn` | 完成事项 | +分值 | +等量分值 | — |
| `redeem_physical` | 实物兑换 | −实付 | 0 | —（可记 rate 快照） |
| `redeem_voucher` | 虚拟券兑换（入背包） | −实付 | 0 | — |
| `use_voucher` | 核销（券出背包） | 0 | 0 | 原兑换记录 |
| `recycle_voucher` | 回收（券出背包） | +⌊实付×0.8⌋ | 0 | 原兑换记录 |
| `adjust` | 补记/改账/撤销冲正 | ±差额 | ±差额 | 原记录 |

- 实物标价：`ceil(人民币 × 20)`（首月 20 分 = 1 元试行；调价不追溯历史流水）。
- 改账**不覆盖**历史：写一条新的 `adjust` 记录关联原记录；错误奖励的冲正同时修正积分和经验。
- `adjust` 防重：同一原记录的**累计更正（正反两向）不得超过原记录的绝对值**——反向防超冲（多返分），正向防虚增（无限加分）；确属大额漏记请另记一笔新的 `earn`。零值记录（核销 0/0）例外，用于撤销核销语义。
- 背包 = 所有未被 `use_voucher` / `recycle_voucher` 引用核销的 `redeem_voucher` 记录。

## CLI 命令（`node scripts/ledger.mjs`）

- `doctor`：账本自检——坏流水 / 重复 id / 无效 ref / 重复核销 / 重复全额冲正 / 累计 adjust 超原额。发现异常时优先跑它。
- `judge "<事项描述>" [--context "..."]`：Jev 定档建议（需 TYPESAFE_API_KEY 或 `~/.typesafe-api-key`），输出选档、概率分布与工作量插值，含低置信度警告。
- 所有写账命令（earn / adjust / redeem / use / recycle）持有数据目录级写锁（`.ledger.lock`，陈旧锁 30s 后自动抢占），防止并发写账把余额刷负。

## tasks.json

```jsonc
{
  "tiers": [5, 10, 20, 50, 100, 200],     // 档位表
  "tasks": [                               // 常用事项示例
    { "id": "brush-teeth", "name": "刷牙", "points": 5, "emoji": "🪥" }
  ]
}
```

## shop.json

```jsonc
{ "items": [
  { "id": "lazy-morning", "name": "赖床券", "type": "voucher", "points": 30, "desc": "…", "emoji": "🛏️" },
  { "id": "milk-tea", "name": "奶茶一杯", "type": "physical", "yuan": 15, "emoji": "🧋" }
] }
```

- `voucher`：`points` 直接定价；`physical`：`yuan` 人民币定价，前端按汇率换算。

## 升级公式

第 N 级 → N+1 级所需经验 = `100 + 10 × (N − 1)`；花积分不扣经验、不掉级。

## 写入约定（Agent 遵守）

1. 每笔一个 JSON 文件，先写 `<id>.json.tmp` 再改名（原子性），避免读到半截文件。
2. 时间字段用带时区的 ISO 8601。
3. 写完回报：本次积分/经验变动、当前余额、当前等级与升级进度。
