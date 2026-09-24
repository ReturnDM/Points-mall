/**
 * 积分商城数据 schema —— 单一事实来源是流水（ledger），余额 / 经验 / 等级全部由流水汇总计算。
 * 约定（详见 docs/schema.md）：
 *  - 每笔流水是一个独立 JSON 文件，文件名 = 记录 id；
 *  - Agent 写账：先写 `*.tmp` 临时文件再改名，避免读到半截文件；
 *  - 改账 / 冲正不覆盖历史：新增一条 type=adjust 的记录，ref 指向原记录；
 *  - 回收：ref 指向原兑换记录，按原实付积分 80% 返还（向下取整），不加经验。
 */

export type LedgerType =
  | 'earn' // 完成事项：积分 + 经验
  | 'redeem_physical' // 实物兑换：扣积分
  | 'redeem_voucher' // 虚拟券兑换：扣积分，券入背包
  | 'use_voucher' // 核销：券出背包，不扣积分
  | 'recycle_voucher' // 回收：券出背包，返还原实付 80% 积分，不加经验
  | 'adjust' // 补记 / 改账 / 撤销冲正，可带负数 points/exp，ref 指向原记录

export interface LedgerEntry {
  /** 唯一 ID，同时是文件名（建议 ULID 或 `YYYYMMDD-HHmmss-随机`） */
  id: string
  /** ISO 8601 时间 */
  time: string
  type: LedgerType
  /** 事项 / 商品名（展示用） */
  title: string
  /** 积分变动，正负号即方向 */
  points: number
  /** 经验变动。只有 earn 与 adjust（冲正）会有非零经验 */
  exp: number
  /** 关联的原记录 id（use / recycle / adjust 使用） */
  ref?: string
  /** 兑换时的实物汇率（积分/元），存快照便于复盘调价 */
  rate?: number
  /** 备注 / 上下文 */
  note?: string
}

export type ShopItemType = 'physical' | 'voucher'

export interface ShopItem {
  id: string
  name: string
  type: ShopItemType
  /** 虚拟券直接用积分定价 */
  points?: number
  /** 实物按人民币定价，前端按当前汇率 ×20 向上取整 */
  yuan?: number
  desc?: string
  emoji?: string
}

export interface TaskPricing {
  /** 档位表，如 [5, 10, 20, 50, 100] */
  tiers: number[]
  /** 常用事项示例，Agent 记账参照 */
  tasks: { id: string; name: string; points: number; emoji?: string }[]
}

export interface DataBundle {
  entries: LedgerEntry[]
  shop: ShopItem[]
  pricing: TaskPricing | null
  /** 实物汇率（积分/元），来自数据目录 config.json，缺省 20 */
  rate: number
  /** 专项计分细则（积分规则.md 原文），可选 */
  rulesMarkdown?: string
  /** 本次读取时间（ISO） */
  readAt: string
  /** 数据目录名（展示用，让用户确认没选错目录） */
  dirName?: string
  /** 读取/解析中出现的坏文件等警告 */
  warnings: string[]
}
