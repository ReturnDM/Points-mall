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
 *                                        # 不带 Δ 则全额冲正（每条记录只能全额冲正一次）
 *   node scripts/ledger.mjs redeem <itemId> [--note "..."]   # 兑换（查 shop.json 定价，余额不足拒绝）
 *   node scripts/ledger.mjs use <redeemId> [--note "..."]    # 核销虚拟券
 *   node scripts/ledger.mjs recycle <redeemId> [--note "..."] # 回收（返还原实付 80%）
 *   node scripts/ledger.mjs doctor                       # 账本自检：坏流水/重复id/无效ref/重复核销
 *   node scripts/ledger.mjs judge "<事项描述>" [--context "..."]  # Jev 定档建议（需 TYPESAFE_API_KEY）
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** 递归读取全部流水（兼容平铺与按年-月等任意层级子目录） */
function readLedger(dataDir) {
  const out = []
  const ledgerDir = join(dataDir, 'ledger')
  if (!existsSync(ledgerDir)) return out
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const relName = rel ? `${rel}/${name}` : name
      if (statSync(full).isDirectory()) {
        walk(full, relName)
      } else if (name.endsWith('.json') && !name.endsWith('.tmp')) {
        try { out.push(JSON.parse(readFileSync(full, 'utf8'))) }
        catch (e) { console.error(`⚠ 跳过坏文件 ledger/${relName}: ${e.message}`) }
      }
    }
  }
  walk(ledgerDir, '')
  return out
}

// ---------- 汇总计算 ----------
const EXP_FOR = (lv) => 100 + 10 * (lv - 1)
function levelFromExp(exp) {
  let lv = 1, rest = Math.max(0, exp), need = EXP_FOR(lv)
  while (rest >= need) { rest -= need; lv++; need = EXP_FOR(lv) }
  return { level: lv, expInLevel: rest, expToNext: need - rest, expRequired: need }
}
const VALID_TYPES = new Set(['earn', 'redeem_physical', 'redeem_voucher', 'use_voucher', 'recycle_voucher', 'adjust'])

function summarize(entries) {
  let points = 0, exp = 0
  // 两遍扫描：先收集「券已被消费」的兑换 id —— 与流水读取顺序无关。
  // 消费 = use/recycle 引用；或 adjust 全额冲正了一条 redeem_voucher（积分已退回，券作废）。
  const consumedRefs = new Set()
  for (const e of entries) {
    if ((e.type === 'use_voucher' || e.type === 'recycle_voucher') && e.ref) {
      consumedRefs.add(e.ref)
      continue
    }
    if (e.type === 'adjust' && e.ref) {
      const orig = entries.find((x) => x.id === e.ref)
      if (orig?.type === 'redeem_voucher' && e.points === -orig.points) consumedRefs.add(orig.id)
    }
  }
  const backpack = entries.filter((e) => e.type === 'redeem_voucher' && !consumedRefs.has(e.id))
  for (const e of entries) { points += e.points; exp += e.exp }
  return { points, exp, level: levelFromExp(exp), backpack }
}
function reportSummary(entries) {
  const rate = readRate(globalThis.__dataDir)
  const s = summarize(entries)
  ok(`余额 ${s.points} 分 ≈ ¥${(s.points / rate).toFixed(2)}（${rate} 分 = 1 元）｜ Lv.${s.level.level}（${s.level.expInLevel}/${s.level.expRequired}，还差 ${s.level.expToNext} 经验升级）｜ 累计经验 ${s.exp} ｜ 背包 ${s.backpack.length} 张券`)
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
  const reversed = entries.find((x) => x.type === 'adjust' && x.ref === id && x.points === -e.points)
  if (reversed) fail(`券 ${id} 的兑换已被全额冲正（记录 ${reversed.id}），券已作废，不能再核销/回收`)
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
    if (fullReverse && entries.some((x) => x.type === 'adjust' && x.ref === orig.id && x.points === -orig.points && x.exp === -orig.exp))
      fail(`记录 ${orig.id} 已被全额冲正过，不能重复冲正（重复冲正会重复返分）；如需再改，请对新产生的 adjust 记录操作`)
    const entry = mkEntry('adjust', String(opts.title ?? `冲正：${orig.title}`), dPoints, dExp, {
      ref: orig.id,
      ...(opts.note ? { note: String(opts.note) } : { note: fullReverse ? `全额冲正 ${orig.id}` : `更正 ${orig.id}` }),
    })
    writeEntry(dataDir, entry)
    ok(`更正成功（${fullReverse ? '全额冲正' : '差额更正'} ${orig.id}）：积分 ${dPoints >= 0 ? '+' : ''}${dPoints}，经验 ${dExp >= 0 ? '+' : ''}${dExp}`)
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
      price = item.points ?? fail(`虚拟券 ${item.name} 缺少 points 定价`)
      extra = { note: `虚拟券兑换，入背包${note ? '；' + note : ''}` }
    } else {
      if (item.yuan === undefined) fail(`实物 ${item.name} 缺少 yuan 定价`)
      price = Math.ceil(item.yuan * rate)
      extra = { rate, note: `实物兑换 ¥${item.yuan} × ${rate}${note ? '；' + note : ''}` }
    }
    const balance = summarize(readLedger(dataDir)).points
    if (balance < price) fail(`余额不足：当前 ${balance} 分，兑换 ${item.name} 需要 ${price} 分（还差 ${price - balance} 分）`)
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
    const opts = parseArgs(rest.slice(1))
    if (cmd === 'use') {
      writeEntry(dataDir, mkEntry('use_voucher', `核销：${orig.title}`, 0, 0, { ref: orig.id, ...(opts.note ? { note: String(opts.note) } : {}) }))
      ok(`核销成功：${orig.title}（不扣积分）`)
    } else {
      const back = Math.floor(-orig.points * 0.8)
      writeEntry(dataDir, mkEntry('recycle_voucher', `回收：${orig.title}`, back, 0, { ref: orig.id, note: `原实付 ${-orig.points} 分 × 80%${opts.note ? '；' + opts.note : ''}` }))
      ok(`回收成功：${orig.title} +${back} 分（原实付 ${-orig.points} × 80%，不加经验）`)
    }
    reportSummary(readLedger(dataDir))
    break
  }
  case 'doctor': {
    const problems = []
    const seen = new Map()
    const entries = []
    const ledgerDir = join(dataDir, 'ledger')
    if (!existsSync(ledgerDir)) { problems.push('缺少 ledger/ 目录') }
    else {
      const walk = (dir, rel) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name)
          const relName = rel ? `${rel}/${name}` : name
          if (statSync(full).isDirectory()) { walk(full, relName); continue }
          if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
          try {
            const e = JSON.parse(readFileSync(full, 'utf8'))
            for (const k of ['id', 'time', 'type', 'title', 'points', 'exp'])
              if (e[k] === undefined) problems.push(`ledger/${relName} 缺少字段 ${k}`)
            if (!VALID_TYPES.has(e.type)) problems.push(`ledger/${relName} 未知类型 ${e.type}`)
            if (!Number.isFinite(e.points) || !Number.isFinite(e.exp)) problems.push(`ledger/${relName} points/exp 不是数字`)
            if (seen.has(e.id)) problems.push(`重复 id：${e.id}（${seen.get(e.id)} 与 ledger/${relName}）`)
            seen.set(e.id, `ledger/${relName}`)
            entries.push(e)
          } catch (err) { problems.push(`坏文件 ledger/${relName}: ${err.message}`) }
        }
      }
      walk(ledgerDir, '')
    }
    // ref 完整性
    for (const e of entries) {
      if (e.ref && !seen.has(e.ref)) problems.push(`${e.id}（${e.type}）引用了不存在的 ref：${e.ref}`)
      if ((e.type === 'use_voucher' || e.type === 'recycle_voucher') && e.ref) {
        const orig = entries.find((x) => x.id === e.ref)
        if (orig && orig.type !== 'redeem_voucher') problems.push(`${e.id} 的 ref ${e.ref} 不是虚拟券兑换（是 ${orig.type}）`)
      }
    }
    // 同一张券被多次核销/回收
    const consumeCount = new Map()
    for (const e of entries) {
      if ((e.type === 'use_voucher' || e.type === 'recycle_voucher') && e.ref)
        consumeCount.set(e.ref, (consumeCount.get(e.ref) ?? 0) + 1)
    }
    for (const [ref, n] of consumeCount) if (n > 1) problems.push(`券 ${ref} 被核销/回收了 ${n} 次`)
    // 同一条记录被多次全额冲正
    const reverseCount = new Map()
    for (const e of entries) {
      if (e.type === 'adjust' && e.ref) {
        const orig = entries.find((x) => x.id === e.ref)
        if (orig && e.points === -orig.points && e.exp === -orig.exp)
          reverseCount.set(e.ref, (reverseCount.get(e.ref) ?? 0) + 1)
      }
    }
    for (const [ref, n] of reverseCount) if (n > 1) problems.push(`记录 ${ref} 被全额冲正了 ${n} 次`)
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
    // 需要环境变量 TYPESAFE_API_KEY（https://console.typesafe.ai/keys）
    const [desc] = rest
    if (!desc) fail('用法：judge "<事项描述>" [--context "补充上下文"]')
    const key = process.env.TYPESAFE_API_KEY
    if (!key) fail('未配置 TYPESAFE_API_KEY 环境变量（从 https://console.typesafe.ai/keys 获取后 setx TYPESAFE_API_KEY <key>）；Jev 复核不可用，可自行定档并在 note 标注')
    const opts = parseArgs(rest.slice(1))
    const tasksPath = join(dataDir, 'tasks.json')
    let tiers = [5, 10, 20, 50, 100, 200]
    try {
      tiers = JSON.parse(readFileSync(tasksPath, 'utf8')).tiers ?? tiers
    } catch { /* 用默认档位 */ }
    const criteria = {}
    for (const t of tiers) criteria[String(t)] = `约 ${t} 分档：${t <= 10 ? '几分钟的日常小事' : t <= 20 ? '半小时内的事务性工作' : t <= 50 ? '几小时、相当于一次课程作业的工作量' : t <= 100 ? '一整天投入或一个完整功能/成果' : '多天的大工程或重大成果'}`
    const state = [
      `事项：${desc}`,
      opts.context ? `上下文：${opts.context}` : '',
      '这是个人生活游戏化积分系统，按完成事项的工作量给积分（1 积分=一次微小完成，100 积分≈一整天工作量）。',
      '请从给定档位中选择最匹配的档位。',
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
    ok(`Jev 建议档位：${a.choice} 分（置信度 ${(a.confidence * 100).toFixed(0)}%）`)
    const probs = Object.entries(a.probabilities ?? {}).map(([k, v]) => `${k}分:${(v * 100).toFixed(0)}%`).join('  ')
    console.log(`   概率分布：${probs}`)
    console.log('   建议流程：与主模型判断对比，相差 ≤50% 取平均；>50% 重新审计一轮，仍分歧则问用户')
    break
  }
  default:
    fail('未知命令。可用：summary / list / earn / adjust / redeem / use / recycle / doctor / judge', 2)
}
