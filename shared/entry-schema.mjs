/**
 * 流水记录字段校验 —— CLI（scripts/ledger.mjs）与前端（src/lib/fsdata.ts）共用的唯一口径。
 * 任何一侧改规则都要改这里，保证「CLI 拒绝的坏数据，前端也不会拿去汇总出 NaN」。
 */

export const VALID_TYPES = new Set([
  'earn',
  'redeem_physical',
  'redeem_voucher',
  'use_voucher',
  'recycle_voucher',
  'adjust',
])

/** 返回错误描述数组；空数组 = 通过校验 */
export function entryErrors(e) {
  if (!e || typeof e !== 'object') return ['记录不是 JSON 对象']
  const errs = []
  for (const k of ['id', 'time', 'type', 'title', 'points', 'exp'])
    if (e[k] === undefined) errs.push(`缺少字段 ${k}`)
  if (!Number.isFinite(e.points) || !Number.isFinite(e.exp))
    errs.push(`points/exp 不是有限数字（${JSON.stringify([e.points, e.exp])}）`)
  if (e.type && !VALID_TYPES.has(e.type)) errs.push(`未知类型 ${e.type}`)
  if (e.time && Number.isNaN(Date.parse(e.time))) errs.push('time 不是合法时间')
  return errs
}
