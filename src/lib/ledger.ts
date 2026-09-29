import type { LedgerEntry } from './types'
import { voucherState } from '../../shared/ledger-state.mjs'

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
  if (!Number.isFinite(totalExp) || Math.abs(totalExp) > Number.MAX_SAFE_INTEGER)
    throw new RangeError('经验总额超出安全计算范围')
  const exp = Math.max(0, totalExp)
  // 跨过 k 级所需经验为 5k(k + 19)；用公式定位，再校正浮点开方的边界误差。
  let crossed = Math.max(0, Math.floor((Math.sqrt(361 + (4 * exp) / 5) - 19) / 2))
  let spent = 5 * crossed * (crossed + 19)
  while (spent > exp) {
    crossed -= 1
    spent = 5 * crossed * (crossed + 19)
  }
  while (5 * (crossed + 1) * (crossed + 20) <= exp) {
    crossed += 1
    spent = 5 * crossed * (crossed + 19)
  }
  const level = crossed + 1
  const remaining = exp - spent
  const need = expForLevel(level)
  return { level, expInLevel: remaining, expToNext: need - remaining, expRequired: need }
}

export interface Summary {
  points: number
  exp: number
  level: LevelInfo
  /** 背包：未核销未回收的虚拟券 */
  backpack: LedgerEntry[]
  /** 券经更正后的当前实付积分，供回收估值展示 */
  voucherPaid: Map<string, number>
}

/** 实物默认汇率：首月试行 20 积分 = 1 元（可被数据目录 config.json 的 physicalRate 覆盖） */
export const DEFAULT_RATE = 20

/** 实物标价：人民币 × 汇率，向上取整 */
export function yuanToPoints(yuan: number, rate: number = DEFAULT_RATE): number {
  return Math.ceil(yuan * rate)
}

/** 回收返还：当前有效实付积分 × 80%，向下取整 */
export function recycleValue(paidPoints: number): number {
  return Math.floor(paidPoints * 0.8)
}

export function summarize(entries: LedgerEntry[]): Summary {
  let points = 0
  let exp = 0
  const { consumed, voided, effectiveTotal } = voucherState(entries)
  const backpack: LedgerEntry[] = []
  const voucherPaid = new Map<string, number>()
  for (const e of entries) {
    points += e.points
    exp += e.exp
    if (e.type === 'redeem_voucher' && !consumed.has(e.id) && !voided.has(e.id)) {
      backpack.push(e)
      voucherPaid.set(e.id, -effectiveTotal(e).points)
    }
  }
  return { points, exp, level: levelFromExp(exp), backpack, voucherPaid }
}

export function sortEntries(entries: LedgerEntry[]): LedgerEntry[] {
  // 用 Date.parse 排序：不同设备写入的 time 时区 offset 可能不同，字符串比较会排错
  return [...entries].sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || b.id.localeCompare(a.id))
}
