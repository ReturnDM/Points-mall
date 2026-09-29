import { entryErrors } from './entry-schema.mjs'

/**
 * Compute the current effect of each entry, including adjustments to adjustments.
 * Zero-value entries (voucher uses) have no numeric effect, so their reversal
 * state is determined by the active zero-value reversal immediately below them.
 */
export function voucherState(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const children = new Map()
  for (const entry of entries) {
    if (entry.type !== 'adjust' || !entry.ref) continue
    const list = children.get(entry.ref) ?? []
    list.push(entry)
    children.set(entry.ref, list)
  }

  const totals = new Map()
  const visiting = new Set()
  const effectiveTotal = (entryOrId) => {
    const entry = typeof entryOrId === 'string' ? byId.get(entryOrId) : entryOrId
    if (!entry) return { points: 0, exp: 0 }
    if (totals.has(entry.id)) return totals.get(entry.id)
    if (visiting.has(entry.id)) throw new Error(`循环 ref：${entry.id}`)
    visiting.add(entry.id)
    const total = { points: entry.points, exp: entry.exp }
    for (const child of children.get(entry.id) ?? []) {
      const effect = effectiveTotal(child)
      total.points += effect.points
      total.exp += effect.exp
    }
    visiting.delete(entry.id)
    totals.set(entry.id, total)
    return total
  }

  const reversed = new Map()
  const isFullyReversed = (entryOrId) => {
    const entry = typeof entryOrId === 'string' ? byId.get(entryOrId) : entryOrId
    if (!entry) return false
    if (reversed.has(entry.id)) return reversed.get(entry.id)
    let result
    if (entry.points === 0 && entry.exp === 0) {
      result = (children.get(entry.id) ?? []).some((child) =>
        child.points === 0 && child.exp === 0 && !isFullyReversed(child))
    } else {
      const effect = effectiveTotal(entry)
      result = effect.points === 0 && effect.exp === 0
    }
    reversed.set(entry.id, result)
    return result
  }

  const consumed = new Set()
  const voided = new Set()
  const activeConsumptions = new Map()
  for (const entry of entries) {
    if (entry.type === 'redeem_voucher' && isFullyReversed(entry)) voided.add(entry.id)
    if ((entry.type === 'use_voucher' || entry.type === 'recycle_voucher') && !isFullyReversed(entry)) {
      consumed.add(entry.ref)
      const list = activeConsumptions.get(entry.ref) ?? []
      list.push(entry)
      activeConsumptions.set(entry.ref, list)
    }
  }
  return { consumed, voided, activeConsumptions, isFullyReversed, effectiveTotal }
}

/** Account-level errors shared by the CLI and browser. Empty means trustworthy. */
export function ledgerErrors(entries) {
  const problems = []
  const byId = new Map()
  for (const entry of entries) {
    const errors = entryErrors(entry)
    if (errors.length) {
      problems.push(`${entry?.id ?? '无 id 记录'}：${errors.join('；')}`)
      continue
    }
    if (typeof entry.id !== 'string' || !entry.id) problems.push('记录 id 必须是非空字符串')
    else if (byId.has(entry.id)) problems.push(`重复 id：${entry.id}`)
    else byId.set(entry.id, entry)

    if (typeof entry.title !== 'string' || !entry.title) problems.push(`${entry.id} 的 title 必须是非空字符串`)
    if (typeof entry.time !== 'string' || Number.isNaN(Date.parse(entry.time))) problems.push(`${entry.id} 的 time 非法`)
    if (['earn', 'redeem_physical', 'redeem_voucher'].includes(entry.type) && entry.ref !== undefined)
      problems.push(`${entry.id}（${entry.type}）不应包含 ref`)
    if (entry.type === 'earn' && (entry.points <= 0 || entry.exp !== entry.points))
      problems.push(`${entry.id} 的 earn 积分必须为正，经验须等于积分`)
    if ((entry.type === 'redeem_physical' || entry.type === 'redeem_voucher') && (entry.points >= 0 || entry.exp !== 0))
      problems.push(`${entry.id} 的兑换积分必须为负，经验须为零`)
    if (entry.type === 'use_voucher' && (entry.points !== 0 || entry.exp !== 0))
      problems.push(`${entry.id} 的核销积分和经验须为零`)
    if (entry.type === 'recycle_voucher' && (entry.points < 0 || entry.exp !== 0))
      problems.push(`${entry.id} 的回收积分不能为负，经验须为零`)
  }
  if (problems.length) return problems

  // Bound the sum of absolute changes, not only the final balance: this also
  // keeps every intermediate/subtree sum exact regardless of file order.
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER)
  let grossPoints = 0n, grossExp = 0n
  for (const entry of entries) {
    grossPoints += BigInt(Math.abs(entry.points))
    grossExp += BigInt(Math.abs(entry.exp))
  }
  if (grossPoints > maxSafe) problems.push('账本累计积分变动超过安全整数范围')
  if (grossExp > maxSafe) problems.push('账本累计经验变动超过安全整数范围')
  if (problems.length) return problems

  for (const entry of entries) {
    if (['use_voucher', 'recycle_voucher', 'adjust'].includes(entry.type)) {
      if (typeof entry.ref !== 'string' || !entry.ref) {
        problems.push(`${entry.id}（${entry.type}）缺少 ref`)
        continue
      }
      const target = byId.get(entry.ref)
      if (!target) {
        problems.push(`${entry.id}（${entry.type}）引用了不存在的 ref：${entry.ref}`)
        continue
      }
      if ((entry.type === 'use_voucher' || entry.type === 'recycle_voucher') && target.type !== 'redeem_voucher')
        problems.push(`${entry.id} 的 ref ${entry.ref} 不是虚拟券兑换（是 ${target.type}）`)
      if (entry.type === 'adjust' && target.points === 0 && target.exp === 0 && (entry.points !== 0 || entry.exp !== 0))
        problems.push(`${entry.id} 对零值记录 ${target.id} 的更正只能是 0 分 / 0 经验`)
    }
  }
  if (problems.length) return problems

  // A ref cycle would otherwise make the recursive state calculation unbounded.
  for (const entry of entries) {
    const visited = new Set()
    let cursor = entry
    while (cursor?.ref && byId.has(cursor.ref)) {
      if (visited.has(cursor.id)) {
        problems.push(`循环 ref：${entry.id}`)
        break
      }
      visited.add(cursor.id)
      cursor = byId.get(cursor.ref)
    }
  }
  if (problems.length) return problems

  const state = voucherState(entries)
  const zeroAdjustments = new Map()
  for (const entry of entries) {
    if (entry.type !== 'adjust' || entry.points !== 0 || entry.exp !== 0) continue
    const list = zeroAdjustments.get(entry.ref) ?? []
    list.push(entry)
    zeroAdjustments.set(entry.ref, list)
  }
  for (const entry of entries) {
    if (entry.points === 0 && entry.exp === 0) {
      const activeReversals = (zeroAdjustments.get(entry.id) ?? [])
        .filter((candidate) => !state.isFullyReversed(candidate))
      if (activeReversals.length > 1)
        problems.push(`零值记录 ${entry.id} 被有效冲正了 ${activeReversals.length} 次`)
    }
    if (entry.type === 'adjust') continue
    if (entry.points === 0 && entry.exp === 0) continue
    const effect = state.effectiveTotal(entry)
    const deltaPoints = effect.points - entry.points
    const deltaExp = effect.exp - entry.exp
    if (Math.abs(deltaPoints) > Math.abs(entry.points) || Math.abs(deltaExp) > Math.abs(entry.exp))
      problems.push(`记录 ${entry.id} 的累计 adjust（${deltaPoints} 分 / ${deltaExp} 经验）超过原额（±${Math.abs(entry.points)} / ±${Math.abs(entry.exp)}）`)
  }
  for (const entry of entries) {
    if (entry.type !== 'adjust' || (entry.points === 0 && entry.exp === 0)) continue
    const effect = state.effectiveTotal(entry)
    const deltaPoints = effect.points - entry.points
    const deltaExp = effect.exp - entry.exp
    if (Math.abs(deltaPoints) > Math.abs(entry.points) || Math.abs(deltaExp) > Math.abs(entry.exp))
      problems.push(`记录 ${entry.id} 的累计 adjust（${deltaPoints} 分 / ${deltaExp} 经验）超过原额（±${Math.abs(entry.points)} / ±${Math.abs(entry.exp)}）`)
  }
  for (const [ref, uses] of state.activeConsumptions) {
    if (uses.length > 1) problems.push(`券 ${ref} 被核销/回收了 ${uses.length} 次`)
    if (state.voided.has(ref)) problems.push(`已作废的券 ${ref} 仍被有效核销/回收`)
    const redeem = byId.get(ref)
    if (!redeem) continue
    const paid = -state.effectiveTotal(redeem).points
    for (const use of uses) {
      if (use.type !== 'recycle_voucher') continue
      const returned = state.effectiveTotal(use).points
      const maxReturn = Math.floor(Math.max(0, paid) * 0.8)
      if (returned > maxReturn)
        problems.push(`回收 ${use.id} 返还 ${returned} 分，超过券 ${ref} 当前实付 ${paid} 分可返的 ${maxReturn} 分`)
    }
  }
  return problems
}
