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
 *                                        # 不带 Δ 则全额冲正；已冲正的记录须先撤销该冲正
 *                                        # 累计更正（正反两向）不得超过原记录的绝对值，防超冲/虚增
 *   node scripts/ledger.mjs redeem <itemId> [--note "..."]   # 兑换（查 shop.json 定价，余额不足拒绝）
 *   node scripts/ledger.mjs use <redeemId> [--note "..."]    # 核销虚拟券
 *   node scripts/ledger.mjs recycle <redeemId> [--note "..."] # 回收（返还当前有效实付的 80%）
 *   node scripts/ledger.mjs doctor                       # 账本自检：坏流水/重复id/无效ref/重复核销
 *   node scripts/ledger.mjs judge "<事项描述>" [--context "..."]  # Jev 定档建议（需 TYPESAFE_API_KEY）
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { entryErrors } from '../shared/entry-schema.mjs'
import { ledgerErrors, voucherState } from '../shared/ledger-state.mjs'

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEFAULT_RATE = 20

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

/** 实物汇率：数据目录 config.json 的 physicalRate > 默认 20 */
function readRate(dataDir) {
  try {
    const cfg = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
    if (Number.isFinite(cfg.physicalRate) && cfg.physicalRate > 0) return cfg.physicalRate
  } catch { /* 无 config.json 用默认值 */ }
  return DEFAULT_RATE
}

// ---------- 基础设施 ----------
function fail(msg, code = 1) { console.error('❌ ' + msg); process.exit(code) }
function ok(msg) { console.log('✅ ' + msg) }

function fmtLocal(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
function genId(now) {
  const rand = Array.from({ length: 4 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('')
  return `${fmtLocal(now)}-${rand}`
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
  const dir = join(dataDir, 'ledger', entry.time.slice(0, 7))
  mkdirSync(dir, { recursive: true })
  const final = join(dir, entry.id + '.json')
  if (existsSync(final)) fail(`记录 id 已存在：${entry.id}`)
  const tmp = final + '.tmp'
  writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', 'utf8')
  renameSync(tmp, final)
  return final
}

// ---------- 写锁：防止并发写账（如两个 Agent 同时 redeem 把余额刷负） ----------
const LOCK_NAME = '.ledger.lock'
const LOCK_STALE_MS = 30_000
let heldLock = null
// 只有持有者可释放锁；持有进程仍存活时，扫描再久也不能抢占。
function releaseHeldLock() {
  if (!heldLock) return
  const { path, token } = heldLock
  heldLock = null
  try {
    if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path)
  } catch { /* 锁已移除或被替换 */ }
}
process.on('exit', releaseHeldLock)

function processAlive(pid) {
  try { process.kill(pid, 0); return true }
  catch (err) { return err.code !== 'ESRCH' }
}

/** 获取数据目录级写锁；返回释放函数。抢不到则 fail。 */
function acquireLock(dataDir) {
  const lock = join(dataDir, LOCK_NAME)
  const deadline = Date.now() + 5000
  const owner = { pid: process.pid, host: hostname(), token: randomUUID() }
  while (true) {
    try {
      const fd = openSync(lock, 'wx')
      let written = false
      try { writeFileSync(fd, JSON.stringify(owner), 'utf8'); written = true }
      finally {
        closeSync(fd)
        if (!written) { try { unlinkSync(lock) } catch { /* 忽略 */ } }
      }
      heldLock = { path: lock, token: owner.token }
      return releaseHeldLock
    } catch (err) {
      if (err.code !== 'EEXIST') fail(`无法创建写锁 ${lock}：${err.message}`)
      // 无法确认持有者死亡的锁绝不抢占，避免旧进程删除新锁。
      try {
        const current = JSON.parse(readFileSync(lock, 'utf8'))
        if (current.host === owner.host && Number.isSafeInteger(current.pid) &&
            !processAlive(current.pid) && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          console.error(`⚠ 已确认写锁持有进程退出，清理陈旧锁：${lock}`)
          unlinkSync(lock)
          continue
        }
      } catch { /* 锁刚好被释放，重试 */ }
      if (Date.now() > deadline) fail('获取写锁超时（5s）：另一笔写账仍在进行，或锁的持有者无法确认；请检查 .ledger.lock')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100) // sleep 100ms
    }
  }
}

/** 递归读取全部流水（兼容平铺与按年-月等任意层级子目录）。
 *  返回 { entries, bad }；bad = 坏文件清单，写账命令必须据此拒绝写入。 */
function readLedgerEx(dataDir) {
  const entries = []
  const bad = []
  const invalid = []
  const ledgerDir = join(dataDir, 'ledger')
  if (!existsSync(ledgerDir)) return { entries, bad, invalid }
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const relName = rel ? `${rel}/${name}` : name
      if (statSync(full).isDirectory()) {
        walk(full, relName)
      } else if (name.endsWith('.json') && !name.endsWith('.tmp')) {
        try {
          const e = JSON.parse(readFileSync(full, 'utf8'))
          // 字段级校验（口径在 shared/entry-schema.mjs，与前端共用）：
          // 通过的才进 entries（summary 也不会再被坏数据污染出 NaN）
          const errs = entryErrors(e)
          if (errs.length > 0) invalid.push(`ledger/${relName}: ${errs.join('；')}`)
          else {
            if (name !== `${e.id}.json`) invalid.push(`ledger/${relName}: 文件名与记录 id ${e.id} 不一致`)
            entries.push(e)
          }
        } catch (err) { bad.push(`ledger/${relName}: ${err.message}`) }
      }
    }
  }
  walk(ledgerDir, '')
  return { entries, bad, invalid }
}

/** 普通读取：坏文件/坏字段告警后跳过（list / summary / doctor 可用） */
function readLedger(dataDir) {
  const { entries, bad, invalid } = readLedgerEx(dataDir)
  for (const b of bad) console.error(`⚠ 跳过坏文件 ${b}`)
  for (const v of invalid) console.error(`⚠ 跳过异常流水 ${v}`)
  return entries
}

/** 严格读取：任何坏文件或字段异常都拒绝——写账前账本必须完整可信 */
function readLedgerStrict(dataDir, purpose = '写账') {
  const { entries, bad, invalid } = readLedgerEx(dataDir)
  const problems = [...bad, ...invalid, ...ledgerErrors(entries)]
  if (problems.length > 0) {
    console.error(`账本存在问题，拒绝${purpose}：`)
    for (const problem of problems) console.error(`  ⚠ ${problem}`)
    fail(`共 ${problems.length} 个问题，先修复或移走它们（可用 doctor 查看），再重试`)
  }
  return entries
}

function writeValidatedEntry(dataDir, entries, entry) {
  const problems = ledgerErrors([...entries, entry])
  if (problems.length) fail(`这笔操作会使账本无效，拒绝写账：${problems.join('；')}`)
  return writeEntry(dataDir, entry)
}

// ---------- 汇总计算 ----------
const EXP_FOR = (lv) => 100 + 10 * (lv - 1)

function levelFromExp(exp) {
  const earned = Math.max(0, exp)
  const totalForTransitions = (n) => 5 * n * n + 95 * n
  let transitions = Math.max(0, Math.floor((Math.sqrt(9025 + 20 * earned) - 95) / 10))
  // Correct floating-point rounding at very large, but still safe, totals.
  while (totalForTransitions(transitions + 1) <= earned) transitions++
  while (transitions > 0 && totalForTransitions(transitions) > earned) transitions--
  const level = transitions + 1
  const expInLevel = earned - totalForTransitions(transitions)
  const expRequired = EXP_FOR(level)
  return { level, expInLevel, expToNext: expRequired - expInLevel, expRequired }
}

function summarize(entries) {
  let points = 0, exp = 0
  const { consumed, voided } = voucherState(entries)
  const backpack = entries.filter((e) => e.type === 'redeem_voucher' && !consumed.has(e.id) && !voided.has(e.id))
  for (const e of entries) { points += e.points; exp += e.exp }
  return { points, exp, level: levelFromExp(exp), backpack }
}
function reportSummary(entries) {
  const rate = readRate(globalThis.__dataDir)
  const s = summarize(entries)
  ok(`余额 ${s.points} 分 ≈ ¥${(s.points / rate).toFixed(2)}（${rate} 分 = 1 元）｜ Lv.${s.level.level}（${s.level.expInLevel}/${s.level.expRequired}，还差 ${s.level.expToNext} 经验升级）｜ 累计经验 ${s.exp} ｜ 背包 ${s.backpack.length} 张券`)
  if (s.backpack.length) {
    const state = voucherState(entries)
    for (const c of s.backpack) {
      const paid = -state.effectiveTotal(c).points
      console.log(`   🎟️ ${c.title}（${c.id}，当前实付 ${paid} 分，回收可得 ${Math.floor(paid * 0.8)} 分）`)
    }
  }
}

// ---------- ref 校验 ----------
function findEntry(entries, id, expectType) {
  const e = entries.find((x) => x.id === id)
  if (!e) fail(`找不到记录 ${id}（先 list 查一下）`)
  if (expectType && e.type !== expectType) fail(`记录 ${id} 类型是 ${e.type}，不是 ${expectType}`)
  return e
}
function adjustmentRoot(entries, entry) {
  let root = entry
  while (root.type === 'adjust') root = findEntry(entries, root.ref)
  return root
}
function ensureVoucherActive(entries, id) {
  const e = findEntry(entries, id, 'redeem_voucher')
  const state = voucherState(entries)
  if (state.voided.has(id)) fail(`券 ${id} 的兑换已被全额冲正，券已作废，不能再核销/回收`)
  if (state.consumed.has(id)) {
    const spent = state.activeConsumptions.get(id)[0]
    fail(`券 ${id} 已被${spent.type === 'use_voucher' ? '核销' : '回收'}（记录 ${spent.id}），不能重复操作`)
  }
  return e
}

// ---------- 命令 ----------
const [, , cmd, ...rest] = process.argv
const dataDir = resolveDataDir()
globalThis.__dataDir = dataDir

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

function readShop(dataDir) {
  const shopPath = join(dataDir, 'shop.json')
  if (!existsSync(shopPath)) fail('缺少 shop.json')
  const shop = JSON.parse(readFileSync(shopPath, 'utf8'))
  return Array.isArray(shop) ? shop : (shop.items ?? [])
}

switch (cmd) {
  case 'summary': {
    reportSummary(readLedgerStrict(dataDir, '汇总'))
    break
  }
  case 'list': {
    const opts = parseArgs(rest)
    // 用 Date.parse 排序：time 的时区 offset 可能不同，字符串比较会排错；同秒并列时按 id 稳定排序
    let entries = readLedger(dataDir).sort((a, b) => (Date.parse(b.time) - Date.parse(a.time)) || b.id.localeCompare(a.id))
    if (opts.type) entries = entries.filter((e) => e.type === opts.type)
    const limit = Number(opts.limit ?? 20)
    for (const e of entries.slice(0, limit))
      console.log(`${e.time.slice(0, 16)}  [${e.type}] ${e.id}  ${e.title}  ${e.points >= 0 ? '+' : ''}${e.points}分${e.exp ? ` exp${e.exp > 0 ? '+' : ''}${e.exp}` : ''}${e.note ? `  ✎ ${e.note}` : ''}`)
    console.log(`—— 共 ${entries.length} 条${entries.length > limit ? `（仅显示前 ${limit}）` : ''}`)
    break
  }
  case 'earn': {
    const [title, pointsStr] = rest
    if (!title || !Number.isSafeInteger(Number(pointsStr))) fail('用法：earn <title> <安全整数 points> [--note "..."]')
    const pts = Number(pointsStr)
    if (pts <= 0) fail('earn 的积分必须为正数；冲正请用 adjust --ref')
    const opts = parseArgs(rest.slice(2))
    const release = acquireLock(dataDir)
    try {
      const entries = readLedgerStrict(dataDir)
      const entry = mkEntry('earn', title, pts, pts, opts.note ? { note: String(opts.note) } : {})
      writeValidatedEntry(dataDir, entries, entry)
      ok(`记账成功：${title} +${pts} 分（+${pts} 经验）`)
    } finally { release() }
    reportSummary(readLedger(dataDir))
    break
  }
  case 'adjust': {
    const opts = parseArgs(rest)
    if (!opts.ref) fail('用法：adjust --ref <id> [--points Δ] [--exp Δ] [--title "..."] [--note "..."]；不带 Δ 则全额冲正')
    const fullReverse = opts.points === undefined && opts.exp === undefined
    const dPoints0 = fullReverse ? 0 : Number(opts.points ?? 0)
    const dExp0 = fullReverse ? 0 : Number(opts.exp ?? 0)
    if (!fullReverse && (!Number.isSafeInteger(dPoints0) || !Number.isSafeInteger(dExp0))) fail('--points / --exp 必须是安全整数')
    const release = acquireLock(dataDir)
    try {
      const entries = readLedgerStrict(dataDir)
      const orig = findEntry(entries, opts.ref)
      const dPoints = fullReverse ? -orig.points : dPoints0
      const dExp = fullReverse ? -orig.exp : dExp0
      const state = voucherState(entries)
      // 零值记录只能作零值语义撤销，绝不能凭空产生积分或经验。
      const zeroOrig = orig.points === 0 && orig.exp === 0
      if (zeroOrig && (dPoints !== 0 || dExp !== 0))
        fail(`零值记录 ${orig.id} 的更正只能是 0 分 / 0 经验`)
      if (state.isFullyReversed(orig))
        fail(`记录 ${orig.id} 已被全额冲正过，不能重复冲正；如需撤销冲正，请对新产生的 adjust 记录操作`)
      // 已被更正的 adjust 可以再更正；这里计算整条冲正子树的当前净额。
      const effect = state.effectiveTotal(orig)
      const adjSum = { p: effect.points - orig.points, e: effect.exp - orig.exp }
      if (!zeroOrig) {
        // 超冲：冲正后累计越过原记录的反向全额（如 +50 的账已冲 -20 再冲 -40）
        const overP = orig.points >= 0 ? adjSum.p + dPoints < -orig.points : adjSum.p + dPoints > -orig.points
        const overE = orig.exp >= 0 ? adjSum.e + dExp < -orig.exp : adjSum.e + dExp > -orig.exp
        // 正向防虚增：累计正向更正不得超过原额（补记最多把该记录翻倍；对兑换记录即退款不超过实付）
        const overPosP = adjSum.p + dPoints > Math.abs(orig.points)
        const overPosE = adjSum.e + dExp > Math.abs(orig.exp)
        if (overP || overE)
          fail(`记录 ${orig.id} 的累计冲正将越过全额（已冲 ${adjSum.p >= 0 ? '+' : ''}${adjSum.p} 分 / ${adjSum.e >= 0 ? '+' : ''}${adjSum.e} 经验，本次再冲 ${dPoints >= 0 ? '+' : ''}${dPoints} / ${dExp >= 0 ? '+' : ''}${dExp}）；最大可冲至 ${-orig.points} 分 / ${-orig.exp} 经验`)
        if (overPosP || overPosE)
          fail(`记录 ${orig.id} 的累计正向更正将超过原额（已累计 ${adjSum.p >= 0 ? '+' : ''}${adjSum.p} 分 / ${adjSum.e >= 0 ? '+' : ''}${adjSum.e} 经验，本次再 +${dPoints} / +${dExp}）；正向补记上限为 +${Math.abs(orig.points)} 分 / +${Math.abs(orig.exp)} 经验。确属大额漏记请另记一笔新的 earn`)
      }
      const root = adjustmentRoot(entries, orig)
      if (root.type === 'redeem_voucher') {
        if (state.consumed.has(root.id) && (dPoints !== 0 || dExp !== 0))
          fail(`券 ${root.id} 已被有效核销/回收，不能再更正兑换金额。如需撤销消费，请先对对应的使用/回收记录做 adjust 冲正`)
      }
      const entry = mkEntry('adjust', String(opts.title ?? `冲正：${orig.title}`), dPoints, dExp, {
        ref: orig.id,
        ...(opts.note ? { note: String(opts.note) } : { note: fullReverse ? `全额冲正 ${orig.id}` : `更正 ${orig.id}` }),
      })
      writeValidatedEntry(dataDir, entries, entry)
      ok(`更正成功（${fullReverse ? '全额冲正' : '差额更正'} ${orig.id}）：积分 ${dPoints >= 0 ? '+' : ''}${dPoints}，经验 ${dExp >= 0 ? '+' : ''}${dExp}`)
    } finally { release() }
    reportSummary(readLedger(dataDir))
    break
  }
  case 'redeem': {
    const [itemId] = rest
    if (!itemId) fail('用法：redeem <itemId> [--note "..."]')
    const item = readShop(dataDir).find((x) => x.id === itemId)
    if (!item) fail(`shop.json 里没有商品 ${itemId}`)
    const rate = readRate(dataDir)
    const note = parseArgs(rest.slice(1)).note
    let price, extra
    if (item.type === 'voucher') {
      price = item.points
      if (!Number.isSafeInteger(price) || price <= 0) fail(`虚拟券 ${item.name} 的 points 定价非法（${JSON.stringify(item.points)}）：必须是正安全整数；请先修正 shop.json`)
      extra = { note: `虚拟券兑换，入背包${note ? '；' + note : ''}` }
    } else {
      if (!Number.isFinite(item.yuan) || item.yuan <= 0) fail(`实物 ${item.name} 的 yuan 定价非法（${JSON.stringify(item.yuan)}）：必须是正数；请先修正 shop.json`)
      price = Math.ceil(item.yuan * rate)
      if (!Number.isSafeInteger(price) || price <= 0) fail(`实物 ${item.name} 的兑换积分超出安全整数范围；请检查 yuan 和汇率`)
      extra = { rate, note: `实物兑换 ¥${item.yuan} × ${rate}${note ? '；' + note : ''}` }
    }
    const release = acquireLock(dataDir)
    try {
      const entries = readLedgerStrict(dataDir)
      const balance = summarize(entries).points
      if (balance < price) fail(`余额不足：当前 ${balance} 分，兑换 ${item.name} 需要 ${price} 分（还差 ${price - balance} 分）`)
      const entry = mkEntry(item.type === 'voucher' ? 'redeem_voucher' : 'redeem_physical', item.name, -price, 0, extra)
      writeValidatedEntry(dataDir, entries, entry)
      ok(`兑换成功：${item.name} −${price} 分${item.type === 'voucher' ? '（券已入背包，用 use 核销 / recycle 回收）' : ''}`)
    } finally { release() }
    reportSummary(readLedger(dataDir))
    break
  }
  case 'use':
  case 'recycle': {
    const [id] = rest
    if (!id) fail(`用法：${cmd} <redeemId> [--note "..."]`)
    const opts = parseArgs(rest.slice(1))
    const release = acquireLock(dataDir)
    try {
      const entries = readLedgerStrict(dataDir)
      const orig = ensureVoucherActive(entries, id)
      if (cmd === 'use') {
        writeValidatedEntry(dataDir, entries, mkEntry('use_voucher', `核销：${orig.title}`, 0, 0, { ref: orig.id, ...(opts.note ? { note: String(opts.note) } : {}) }))
        ok(`核销成功：${orig.title}（不扣积分）`)
      } else {
        const paid = -voucherState(entries).effectiveTotal(orig).points
        const back = Math.floor(paid * 0.8)
        writeValidatedEntry(dataDir, entries, mkEntry('recycle_voucher', `回收：${orig.title}`, back, 0, { ref: orig.id, note: `当前实付 ${paid} 分 × 80%${opts.note ? '；' + opts.note : ''}` }))
        ok(`回收成功：${orig.title} +${back} 分（当前实付 ${paid} × 80%，不加经验）`)
      }
    } finally { release() }
    reportSummary(readLedger(dataDir))
    break
  }
  case 'doctor': {
    const { entries, bad, invalid } = readLedgerEx(dataDir)
    const problems = [
      ...(!existsSync(join(dataDir, 'ledger')) ? ['缺少 ledger/ 目录'] : []),
      ...bad,
      ...invalid,
      ...ledgerErrors(entries),
    ]
    if (problems.length === 0) {
      ok(`账本自检通过：共 ${entries.length} 条流水，无问题`)
    } else {
      for (const p of problems) console.error('⚠ ' + p)
      console.error(`❌ 自检发现 ${problems.length} 个问题`)
      process.exit(1)
    }
    break
  }
  case 'judge': {
    // Jev 定档建议：node scripts/ledger.mjs judge "<事项描述>" [--context "补充上下文"]
    // 双问并行：Choice 选档（可解释 + 分布）+ Score 在档位序列上打位置（概率加权 → 档位间插值）
    const [desc] = rest
    if (!desc) fail('用法：judge "<事项描述>" [--context "补充上下文"]')
    const key = process.env.TYPESAFE_API_KEY
      ?? (() => {
        const f = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.typesafe-api-key')
        try { return readFileSync(f, 'utf8').trim() || undefined } catch { return undefined }
      })()
    if (!key) fail('未找到 key：设置 TYPESAFE_API_KEY 环境变量，或在 ~/.typesafe-api-key 存放（勿进 git）；Jev 复核不可用时可自行定档并在 note 标注')
    const opts = parseArgs(rest.slice(1))
    const tasksPath = join(dataDir, 'tasks.json')
    let tiers = [5, 10, 20, 50, 100, 200]
    try {
      tiers = JSON.parse(readFileSync(tasksPath, 'utf8')).tiers ?? tiers
    } catch { /* 用默认档位 */ }
    const tierDesc = (t) => `约 ${t} 分：${t <= 10 ? '几分钟的日常小事' : t <= 20 ? '半小时内的事务性工作' : t <= 50 ? '几小时、相当于一次课程作业的工作量' : t <= 100 ? '一整天投入或一个完整功能/成果' : '多天的大工程或重大成果'}`
    const criteria = {}
    for (const t of tiers) criteria[String(t)] = tierDesc(t)
    const state = [
      `事项：${desc}`,
      opts.context ? `上下文：${opts.context}` : '',
      '这是个人生活游戏化积分系统，按完成事项的工作量给积分（1 积分=一次微小完成，100 积分≈一整天工作量）。',
      '档位序列（从小到大）：' + tiers.join(' < ') + ' 分。',
    ].filter(Boolean).join('\n')
    let resp
    try {
      resp = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state,
          model: 'jev-latest',
          questions: {
            tier: {
              type: 'choice',
              instructions: '该事项完成应得哪个积分档位？按实际工作量与投入时间判断。',
              criteria,
            },
            effort: {
              type: 'score',
              instructions: `该事项的工作量落在档位序列上的位置。各档位（从第 0 档到第 ${tiers.length - 1} 档）含义如下，按实际投入选最贴切的一档即可，系统会按概率加权折算出档位之间的分值：\n` + tiers.map((t, i) => `第 ${i} 档 = ${tierDesc(t)}`).join('\n'),
              criteria: tiers.map((t) => tierDesc(t)),
            },
          },
        }),
      })
    } catch (e) {
      fail(`Jev 网络调用失败：${e.message}（可自行定档并在 note 标注「未经 Jev 复核」）`)
    }
    if (!resp.ok) fail(`Jev API 返回 ${resp.status}：${await resp.text().then((t) => t.slice(0, 300))}`)
    const data = await resp.json()
    const a = data.answers?.tier
    if (!a) fail('Jev 返回中没有 tier 答案')
    ok(`Jev 选档：${a.choice} 分（置信度 ${(a.confidence * 100).toFixed(0)}%）`)
    const probs = Object.entries(a.probabilities ?? {}).map(([k, v]) => `${k}分:${(v * 100).toFixed(0)}%`).join('  ')
    console.log(`   概率分布：${probs}`)
    if (a.confidence < 0.6) console.log(`   ⚠ 注意：选档置信度仅 ${(a.confidence * 100).toFixed(0)}%（<60%），仅供参考——建议按上下文重判或问用户`)
    const eff = data.answers?.effort
    if (eff && Number.isFinite(eff.score)) {
      // Score 的加权位置 → 在相邻档位间线性插值，得到档位之间的中间分值
      const i = Math.min(Math.max(eff.score, 0), tiers.length - 1)
      const lo = Math.floor(i), hi = Math.min(lo + 1, tiers.length - 1)
      const interpolated = Math.round(tiers[lo] + (tiers[hi] - tiers[lo]) * (i - lo))
      const effortProbs = Object.entries(eff.probabilities ?? {}).map(([k, v]) => `${tiers[Number(k)]}分:${(v * 100).toFixed(0)}%`).join('  ')
      console.log(`   工作量位置：${eff.score.toFixed(2)}（介于 ${tiers[lo]} 与 ${tiers[hi]} 分之间）→ 插值 ≈ ${interpolated} 分（置信度 ${(eff.confidence * 100).toFixed(0)}%）`)
      console.log(`   位置分布：${effortProbs}`)
      // 跨档警告：概率质量散布在不相邻的档位上时，插值没有实际意义
      const significant = Object.entries(eff.probabilities ?? {})
        .map(([k, v]) => ({ idx: Number(k), v }))
        .filter((x) => x.v >= 0.2)
      const warnings = []
      if (significant.length > 1 && Math.max(...significant.map((x) => x.idx)) - Math.min(...significant.map((x) => x.idx)) >= 2)
        warnings.push('概率散布在不相邻档位上，Jev 对工作量拿不准，插值仅供参考')
      if (eff.confidence < 0.6)
        warnings.push(`工作量判断置信度仅 ${(eff.confidence * 100).toFixed(0)}%（<60%）`)
      const choiceIdx = tiers.indexOf(Number(a.choice))
      if (choiceIdx >= 0 && Math.abs(choiceIdx - eff.score) >= 1)
        warnings.push(`选档（${a.choice} 分）与工作量位置（第 ${eff.score.toFixed(1)} 档）相差 ≥1 档，两项判断冲突`)
      if (warnings.length > 0) {
        for (const w of warnings) console.log(`   ⚠ ${w}——建议按上下文重判或问用户`)
        console.log(`⚠ Jev 综合建议（存在上述警告，不可直接采用）：${interpolated} 分（选档 ${a.choice} + 位置插值）`)
      } else {
        ok(`Jev 综合建议：${interpolated} 分（选档 ${a.choice} + 位置插值）`)
      }
    } else {
      ok(`Jev 建议：${a.choice} 分`)
    }
    console.log('   建议流程：与主模型判断对比，相差 ≤50% 取平均；>50% 重新审计一轮，仍分歧则问用户')
    break
  }
  default:
    fail('未知命令。可用：summary / list / earn / adjust / redeem / use / recycle / doctor / judge', 2)
}
