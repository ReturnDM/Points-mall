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
  const isFullyReversed = (rec: LedgerEntry) =>
    entries.some((a) => a.type === 'adjust' && a.ref === rec.id && a.points === -rec.points && a.exp === -rec.exp)
  const consumedRefs = new Set<string>()
  for (const e of entries) {
    if (e.type === 'adjust' && e.ref) {
      const orig = entries.find((x) => x.id === e.ref)
      if (orig?.type === 'redeem_voucher' && e.points === -orig.points && e.exp === -orig.exp) consumedRefs.add(orig.id)
    }
  }
  for (const c of entries) {
    if ((c.type === 'use_voucher' || c.type === 'recycle_voucher') && c.ref && !isFullyReversed(c)) consumedRefs.add(c.ref)
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
  return [...entries].sort((a, b) => (a.time < b.time ? 1 : -1))
}
