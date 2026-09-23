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

/** 实物汇率：首月试行 20 积分 = 1 元 */
export const PHYSICAL_RATE = 20

/** 实物标价：人民币 × 汇率，向上取整 */
export function yuanToPoints(yuan: number): number {
  return Math.ceil(yuan * PHYSICAL_RATE)
}

/** 回收返还：原实付积分 × 80%，向下取整 */
export function recycleValue(paidPoints: number): number {
  return Math.floor(paidPoints * 0.8)
}

export function summarize(entries: LedgerEntry[]): Summary {
  let points = 0
  let exp = 0
  const backpack: LedgerEntry[] = []
  for (const e of entries) {
    points += e.points
    exp += e.exp
    if (e.type === 'redeem_voucher') backpack.push(e)
    if (e.type === 'use_voucher' || e.type === 'recycle_voucher') {
      const i = backpack.findIndex((b) => b.id === e.ref)
      if (i >= 0) backpack.splice(i, 1)
    }
  }
  return { points, exp, level: levelFromExp(exp), backpack }
}

export function sortEntries(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort((a, b) => (a.time < b.time ? 1 : -1))
}
