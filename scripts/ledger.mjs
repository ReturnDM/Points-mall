#!/usr/bin/env node
/**
 * 积分商城记账 CLI —— Agent 的增删查改接口。
 * Agent 不直接写 JSON 文件，只调本命令；schema 校验 / id 生成 / 原子写 / ref 完整性都在这里固化。
 *
 * 用法：
 *   node scripts/ledger.mjs summary                      # 余额/等级/背包
 *   node scripts/ledger.mjs list [--limit 20] [--type earn]
 *   node scripts/ledger.mjs earn <title> <points> [--note "..."]
 *   node scripts/ledger.mjs adjust --ref <id> [--points Δ] [--exp Δ] [--title "..."] [--note "..."]
 *                                        # 不带 Δ 则全额冲正原记录
 *   node scripts/ledger.mjs redeem <itemId> [--note "..."]   # 实物/虚拟券兑换（查 shop.json 定价）
 *   node scripts/ledger.mjs use <redeemId> [--note "..."]    # 核销虚拟券
 *   node scripts/ledger.mjs recycle <redeemId> [--note "..."] # 回收（返还原实付 80%）
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PHYSICAL_RATE = 20

// ---------- 数据目录解析：POINTS_DATA_DIR > config.local.json ----------
function resolveDataDir() {
  if (process.env.POINTS_DATA_DIR) return resolve(process.env.POINTS_DATA_DIR)
  const cfg = join(PROJECT_ROOT, 'config.local.json')
  if (existsSync(cfg)) {
    try {
      const { dataDir } = JSON.parse(readFileSync(cfg, 'utf8'))
      if (dataDir) return resolve(dataDir)
    } catch { /* fallthrough */ }
  }
  fail('未配置数据目录：设置 POINTS_DATA_DIR 或创建 config.local.json（{ "dataDir": "..." }）')
}

// ---------- 基础设施 ----------
function fail(msg, code = 1) { console.error('❌ ' + msg); process.exit(code) }
function ok(msg) { console.log('✅ ' + msg) }

function genId(now) {
  const rand = Array.from({ length: 4 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('')
  return `${fmtLocal(now)}-${rand}`
}
function fmtLocal(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
function isoTime(d) {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const p = (n) => String(Math.abs(n)).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
}

/** 校验后的原子写入：先 tmp 再改名 */
function writeEntry(dataDir, entry) {
  for (const k of ['id', 'time', 'type', 'title', 'points', 'exp'])
    if (entry[k] === undefined) fail(`记录缺少必填字段 ${k}（内部错误）`)
  const month = entry.time.slice(0, 7).replace('-', '-')
  const dir = join(dataDir, 'ledger', month)
  mkdirSync(dir, { recursive: true })
  const final = join(dir, entry.id + '.json')
  if (existsSync(final)) fail(`记录 id 已存在：${entry.id}`)
  const tmp = final + '.tmp'
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', 'utf8')
  renameSync(tmp, final)
  return final
}

/** 递归读取全部流水 */
function readLedger(dataDir) {
  const out = []
  const ledgerDir = join(dataDir, 'ledger')
  if (!existsSync(ledgerDir)) return out
  for (const month of readdirSync(ledgerDir)) {
    const mDir = join(ledgerDir, month)
    try {
      for (const f of readdirSync(mDir)) {
        if (!f.endsWith('.json') || f.endsWith('.tmp')) continue
        try { out.push(JSON.parse(readFileSync(join(mDir, f), 'utf8'))) }
        catch (e) { console.error(`⚠ 跳过坏文件 ledger/${month}/${f}: ${e.message}`) }
      }
    } catch { /* not a dir */ }
  }
  return out
}

// ---------- 汇总计算 ----------
const EXP_FOR = (lv) => 100 + 10 * (lv - 1)
function levelFromExp(exp) {
  let lv = 1, rest = Math.max(0, exp), need = EXP_FOR(lv)
  while (rest >= need) { rest -= need; lv++; need = EXP_FOR(lv) }
  return { level: lv, expInLevel: rest, expToNext: need - rest, expRequired: need }
}
function summarize(entries) {
  let points = 0, exp = 0
  const backpack = []
  for (const e of entries) {
    points += e.points; exp += e.exp
    if (e.type === 'redeem_voucher') backpack.push(e)
    if ((e.type === 'use_voucher' || e.type === 'recycle_voucher') && e.ref) {
      const i = backpack.findIndex((b) => b.id === e.ref)
      if (i >= 0) backpack.splice(i, 1)
    }
  }
  return { points, exp, level: levelFromExp(exp), backpack }
}
function reportSummary(entries) {
  const s = summarize(entries)
  ok(`余额 ${s.points} 分 ≈ ¥${(s.points / PHYSICAL_RATE).toFixed(2)} ｜ Lv.${s.level.level}（${s.level.expInLevel}/${s.level.expRequired}，还差 ${s.level.expToNext} 经验升级）｜ 累计经验 ${s.exp} ｜ 背包 ${s.backpack.length} 张券`)
  if (s.backpack.length)
    for (const c of s.backpack) console.log(`   🎟️ ${c.title}（${c.id}，实付 ${-c.points} 分，回收可得 ${Math.floor(-c.points * 0.8)} 分）`)
}

// ---------- ref 校验 ----------
function findEntry(entries, id, expectType) {
  const e = entries.find((x) => x.id === id)
  if (!e) fail(`找不到记录 ${id}（先 list 查一下）`)
  if (expectType && e.type !== expectType) fail(`记录 ${id} 类型是 ${e.type}，不是 ${expectType}`)
  return e
}
function ensureVoucherActive(entries, id) {
  const e = findEntry(entries, id, 'redeem_voucher')
  const spent = entries.find((x) => (x.type === 'use_voucher' || x.type === 'recycle_voucher') && x.ref === id)
  if (spent) fail(`券 ${id} 已被${spent.type === 'use_voucher' ? '核销' : '回收'}（记录 ${spent.id}），不能重复操作`)
  return e
}

// ---------- 命令 ----------
const [, , cmd, ...rest] = process.argv
const dataDir = resolveDataDir()

function parseArgs(args) {
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[i + 1]?.startsWith('--') ? true : args[++i]
  }
  return opts
}

function mkEntry(type, title, points, exp, extra = {}) {
  const now = new Date()
  return { id: genId(now), time: isoTime(now), type, title, points, exp, ...extra }
}

switch (cmd) {
  case 'summary': {
    reportSummary(readLedger(dataDir))
    break
  }
  case 'list': {
    const opts = parseArgs(rest)
    let entries = readLedger(dataDir).sort((a, b) => (a.time < b.time ? 1 : -1))
    if (opts.type) entries = entries.filter((e) => e.type === opts.type)
    const limit = Number(opts.limit ?? 20)
    for (const e of entries.slice(0, limit))
      console.log(`${e.time.slice(0, 16)}  [${e.type}] ${e.id}  ${e.title}  ${e.points >= 0 ? '+' : ''}${e.points}分${e.exp ? ` exp${e.exp > 0 ? '+' : ''}${e.exp}` : ''}${e.note ? `  ✎ ${e.note}` : ''}`)
    console.log(`—— 共 ${entries.length} 条${entries.length > limit ? `（仅显示前 ${limit}）` : ''}`)
    break
  }
  case 'earn': {
    const [title, pointsStr] = rest
    if (!title || !Number.isFinite(Number(pointsStr))) fail('用法：earn <title> <points> [--note "..."]')
    const pts = Number(pointsStr)
    if (pts <= 0) fail('earn 的积分必须为正数；冲正请用 adjust --ref')
    const opts = parseArgs(rest.slice(2))
    const entry = mkEntry('earn', title, pts, pts, opts.note ? { note: String(opts.note) } : {})
    writeEntry(dataDir, entry)
    ok(`记账成功：${title} +${pts} 分（+${pts} 经验）`)
    reportSummary(readLedger(dataDir))
    break
  }
  case 'adjust': {
    const opts = parseArgs(rest)
    if (!opts.ref) fail('用法：adjust --ref <id> [--points Δ] [--exp Δ] [--title "..."] [--note "..."]；不带 Δ 则全额冲正')
    const entries = readLedger(dataDir)
    const orig = findEntry(entries, opts.ref)
    const fullReverse = opts.points === undefined && opts.exp === undefined
    const dPoints = fullReverse ? -orig.points : Number(opts.points ?? 0)
    const dExp = fullReverse ? -orig.exp : Number(opts.exp ?? 0)
    if (!Number.isFinite(dPoints) || !Number.isFinite(dExp)) fail('--points / --exp 必须是数字')
    const entry = mkEntry('adjust', String(opts.title ?? `冲正：${orig.title}`), dPoints, dExp, {
      ref: orig.id,
      ...(opts.note ? { note: String(opts.note) } : { note: fullReverse ? `全额冲正 ${orig.id}` : `更正 ${orig.id}` }),
    })
    writeEntry(dataDir, entry)
    ok(`更正成功（${fullReverse ? '全额冲正' : '差额更正'} ${orig.id}）：积分 ${dPoints >= 0 ? '+' : ''}${dPoints}，经验 ${dExp >= 0 ? '+' : ''}${dExp}`)
    reportSummary(entries)
    break
  }
  case 'redeem': {
    const [itemId] = rest
    if (!itemId) fail('用法：redeem <itemId> [--note "..."]')
    const shopPath = join(dataDir, 'shop.json')
    if (!existsSync(shopPath)) fail('缺少 shop.json')
    const shop = JSON.parse(readFileSync(shopPath, 'utf8'))
    const items = Array.isArray(shop) ? shop : (shop.items ?? [])
    const item = items.find((x) => x.id === itemId)
    if (!item) fail(`shop.json 里没有商品 ${itemId}`)
    let price, extra
    if (item.type === 'voucher') {
      price = item.points ?? fail(`虚拟券 ${item.name} 缺少 points 定价`)
      extra = { note: `虚拟券兑换，入背包${parseArgs(rest.slice(2)).note ? '；' + parseArgs(rest.slice(2)).note : ''}` }
    } else {
      if (item.yuan === undefined) fail(`实物 ${item.name} 缺少 yuan 定价`)
      price = Math.ceil(item.yuan * PHYSICAL_RATE)
      extra = { rate: PHYSICAL_RATE, note: `实物兑换 ¥${item.yuan} × ${PHYSICAL_RATE}${parseArgs(rest.slice(2)).note ? '；' + parseArgs(rest.slice(2)).note : ''}` }
    }
    const entry = mkEntry(item.type === 'voucher' ? 'redeem_voucher' : 'redeem_physical', item.name, -price, 0, extra)
    writeEntry(dataDir, entry)
    ok(`兑换成功：${item.name} −${price} 分${item.type === 'voucher' ? '（券已入背包，用 use 核销 / recycle 回收）' : ''}`)
    reportSummary(readLedger(dataDir))
    break
  }
  case 'use':
  case 'recycle': {
    const [id] = rest
    if (!id) fail(`用法：${cmd} <redeemId> [--note "..."]`)
    const entries = readLedger(dataDir)
    const orig = ensureVoucherActive(entries, id)
    const opts = parseArgs(rest.slice(2))
    if (cmd === 'use') {
      writeEntry(dataDir, mkEntry('use_voucher', `核销：${orig.title}`, 0, 0, { ref: orig.id, ...(opts.note ? { note: String(opts.note) } : {}) }))
      ok(`核销成功：${orig.title}（不扣积分）`)
    } else {
      const back = Math.floor(-orig.points * 0.8)
      writeEntry(dataDir, mkEntry('recycle_voucher', `回收：${orig.title}`, back, 0, { ref: orig.id, note: `原实付 ${-orig.points} 分 × 80%${opts.note ? '；' + opts.note : ''}` }))
      ok(`回收成功：${orig.title} +${back} 分（原实付 ${-orig.points} × 80%，不加经验）`)
    }
    reportSummary(entries)
    break
  }
  default:
    fail('未知命令。可用：summary / list / earn / adjust / redeem / use / recycle', 2)
}
