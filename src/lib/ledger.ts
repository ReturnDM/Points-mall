import type { LedgerEntry } from './types'

/**
 * 升级公式：第 N 级 → N+1 级所需经验 = 100 + 10 × (N - 1)
 */
export function expForLevel(level: number): number {
  return 100 + 10 * (level - 1)
}

export interface LevelInfo {
  level: number
  /** 当前级内已积累经验 */
  expInLevel: number
  /** 升到下一级还差多少 */
  expToNext: number
  /** 本级所需总经验 */
  expRequired: number
}

export function levelFromExp(totalExp: number): LevelInfo {
  let level = 1
  let remaining = Math.max(0, totalExp)
  let need = expForLevel(level)
  while (remaining >= need) {
    remaining -= need
    level += 1
    need = expForLevel(level)
  }
  return { level, expInLevel: remaining, expToNext: need - remaining, expRequired: need }
}

export interface Summary {
  points: number
  exp: number
  level: LevelInfo
  /** 背包：未核销未回收的虚拟券 */
  backpack: LedgerEntry[]
}

/** 实物默认汇率：首月试行 20 积分 = 1 元（可被数据目录 config.json 的 physicalRate 覆盖） */
export const DEFAULT_RATE = 20

/** 实物标价：人民币 × 汇率，向上取整 */
export function yuanToPoints(yuan: number, rate: number = DEFAULT_RATE): number {
  return Math.ceil(yuan * rate)
}

/** 回收返还：原实付积分 × 80%，向下取整 */
export function recycleValue(paidPoints: number): number {
  return Math.floor(paidPoints * 0.8)
}

export function summarize(entries: LedgerEntry[]): Summary {
  let points = 0
  let exp = 0
  // 与 scripts/ledger.mjs 的 computeConsumed 口径一致：
  // 券被消费 = 存在「未被全额冲正」的核销/回收记录引用它；
  // 另外 adjust 全额冲正兑换记录本身 → 券作废。
  // 先建 id 索引再判定，避免嵌套 find 的 O(n²)。
  const byId = new Map(entries.map((e) => [e.id, e]))
  // 「累计全额冲正」的判定与 CLI 逐条比对口径一致：存在某一条 adjust 恰好等于原记录的反向全额
  const reversedIds = new Set<string>()
  for (const a of entries) {
    if (a.type !== 'adjust' || !a.ref) continue
    const orig = byId.get(a.ref)
    if (orig && a.points === -orig.points && a.exp === -orig.exp) reversedIds.add(a.ref)
  }
  const consumedRefs = new Set<string>()
  // 1) adjust 全额冲正了兑换记录本身 → 券作废
  for (const id of reversedIds) {
    if (byId.get(id)?.type === 'redeem_voucher') consumedRefs.add(id)
  }
  // 2) 有效（未被撤销）的核销/回收 → 券被消费
  for (const c of entries) {
    if ((c.type === 'use_voucher' || c.type === 'recycle_voucher') && c.ref && !reversedIds.has(c.id)) consumedRefs.add(c.ref)
  }
  const backpack: LedgerEntry[] = []
  for (const e of entries) {
    points += e.points
    exp += e.exp
    if (e.type === 'redeem_voucher' && !consumedRefs.has(e.id)) backpack.push(e)
  }
  return { points, exp, level: levelFromExp(exp), backpack }
}

export function sortEntries(entries: LedgerEntry[]): LedgerEntry[] {
  // 用 Date.parse 排序：不同设备写入的 time 时区 offset 可能不同，字符串比较会排错
  return [...entries].sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || b.id.localeCompare(a.id))
}
