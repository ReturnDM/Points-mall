// CLI 冒烟测试：node --test scripts/ledger.test.mjs（需 Node 20+）
// 在临时数据目录上跑真实 CLI，验证写账主路径与防重护栏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'ledger.mjs')

function makeDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'points-test-'))
  mkdirSync(join(dir, 'ledger'), { recursive: true })
  writeFileSync(join(dir, 'shop.json'), JSON.stringify({
    items: [
      { id: 'lazy', name: '赖床券', type: 'voucher', points: 30 },
      { id: 'tea', name: '奶茶', type: 'physical', 'yuan': 2 },
    ],
  }))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ physicalRate: 20 }))
  return dir
}

function run(dir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, POINTS_DATA_DIR: dir },
    encoding: 'utf8',
    timeout: 10_000,
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

function findId(dir, type) {
  const id = run(dir, 'list', '--limit', '100').out.match(new RegExp(`\\[${type}\\] (\\S+)`))?.[1]
  assert.ok(id, `应有 ${type} 记录`)
  return id
}

function putFixture(dir, entry, folder = 'fixture') {
  const target = join(dir, 'ledger', folder)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, `${entry.id}.json`), JSON.stringify(entry))
}

function fixture(id, type, points, exp, ref) {
  return { id, time: '2026-09-25T12:00:00+08:00', type, title: id, points, exp, ...(ref ? { ref } : {}) }
}

function findAdjustmentFor(dir, ref) {
  const walk = (folder) => readdirSync(folder, { withFileTypes: true }).flatMap((item) => {
    const path = join(folder, item.name)
    return item.isDirectory() ? walk(path) : item.name.endsWith('.json') ? [JSON.parse(readFileSync(path, 'utf8'))] : []
  })
  const matches = walk(join(dir, 'ledger')).filter((entry) => entry.type === 'adjust' && entry.ref === ref)
  assert.equal(matches.length, 1, `应有且仅有一条针对 ${ref} 的更正`)
  return matches[0].id
}

test('earn / summary / adjust 全额冲正防重 / 超冲 / 正向上限', () => {
  const dir = makeDataDir()
  try {
    let r = run(dir, 'earn', '写作业', '50', '--note', '测试')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /\+50 分/)

    // 首次全额冲正 OK
    const listOut = run(dir, 'list', '--limit', '10').out
    const earnId = listOut.match(/\[earn\] (\S+)/)?.[1]
    assert.ok(earnId, 'list 应能找到 earn 记录 id')
    r = run(dir, 'adjust', '--ref', earnId)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /余额 0 分/)

    // 重复全额冲正拒绝（冲正到全额后，该记录已不能再动）
    r = run(dir, 'adjust', '--ref', earnId)
    assert.notEqual(r.code, 0)
    assert.match(r.out, /不能重复冲正|越过全额/)

    // 正向更正超过原额拒绝（在一笔新账上验证：原 +50，累计上限 +50）
    run(dir, 'earn', '新事项', '50')
    // 同秒两笔 earn 排序可能并列，取「不同于第一笔」的那笔
    const earnIds = [...run(dir, 'list', '--limit', '10').out.matchAll(/\[earn\] (\S+)/g)].map((m) => m[1])
    const earnId2 = earnIds.find((x) => x !== earnId)
    assert.ok(earnId2, '应有两笔不同的 earn')
    r = run(dir, 'adjust', '--ref', earnId2, '--points', '51', '--exp', '51')
    assert.notEqual(r.code, 0)
    assert.match(r.out, /累计正向更正将超过原额/)
    r = run(dir, 'adjust', '--ref', earnId2, '--points', '50', '--exp', '50')
    assert.equal(r.code, 0, r.out)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('redeem / use / recycle 与重复核销拦截', () => {
  const dir = makeDataDir()
  try {
    run(dir, 'earn', '攒分', '100')
    let r = run(dir, 'redeem', 'lazy')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /兑换成功：赖床券 −30 分/)

    const redeemId = run(dir, 'list', '--limit', '10').out.match(/\[redeem_voucher\] (\S+)/)?.[1]
    assert.ok(redeemId)

    r = run(dir, 'use', redeemId)
    assert.equal(r.code, 0, r.out)
    // 重复核销拒绝
    r = run(dir, 'use', redeemId)
    assert.notEqual(r.code, 0)
    assert.match(r.out, /不能重复操作/)

    // 回收另一张：earn +100，再兑一张再回收 → 余额 = 100 - 30 + 24
    run(dir, 'earn', '再攒', '100')
    r = run(dir, 'redeem', 'lazy')
    assert.equal(r.code, 0, r.out)
    // 同秒内两笔兑换排序可能并列，取「不同于第一张」的那张
    const ids = [...run(dir, 'list', '--limit', '10').out.matchAll(/\[redeem_voucher\] (\S+)/g)].map((m) => m[1])
    const id2 = ids.find((x) => x !== redeemId)
    assert.ok(id2, '应有两张不同的券')
    r = run(dir, 'recycle', id2)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /\+24 分/)
    // 100 - 30(券1) + 100 - 30(券2) + 24(回收) = 164
    assert.match(run(dir, 'summary').out, /余额 164 分/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('余额不足拒绝兑换', () => {
  const dir = makeDataDir()
  try {
    run(dir, 'earn', '小分', '10')
    const r = run(dir, 'redeem', 'lazy')
    assert.notEqual(r.code, 0)
    assert.match(r.out, /余额不足/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('坏流水会让写账拒绝（readLedgerStrict）', () => {
  const dir = makeDataDir()
  try {
    writeFileSync(join(dir, 'ledger', 'bad.json'), '{ not json')
    const r = run(dir, 'earn', '测试', '5')
    assert.notEqual(r.code, 0)
    assert.match(r.out, /拒绝写账/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('doctor 通过完整流程后的账本', () => {
  const dir = makeDataDir()
  try {
    run(dir, 'earn', '事项A', '20')
    const id = run(dir, 'list').out.match(/\[earn\] (\S+)/)?.[1]
    run(dir, 'adjust', '--ref', id, '--points', '-5', '--exp', '-5', '--note', '记多了')
    run(dir, 'earn', '事项B', '50')
    run(dir, 'redeem', 'lazy')
    const vid = run(dir, 'list', '--limit', '10').out.match(/\[redeem_voucher\] (\S+)/)?.[1]
    run(dir, 'use', vid)
    const r = run(dir, 'doctor')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /自检通过/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('核销及零值冲正不允许注入非零积分或经验', () => {
  const dir = makeDataDir()
  try {
    assert.equal(run(dir, 'earn', '攒分', '100').code, 0)
    assert.equal(run(dir, 'redeem', 'lazy').code, 0)
    const voucher = findId(dir, 'redeem_voucher')
    assert.equal(run(dir, 'use', voucher).code, 0)
    const use = findId(dir, 'use_voucher')
    for (const args of [['--points', '1000000'], ['--exp', '1000000']]) {
      const attempt = run(dir, 'adjust', '--ref', use, ...args)
      assert.notEqual(attempt.code, 0)
      assert.match(attempt.out, /零值记录.*只能是 0 分/)
    }
    assert.match(run(dir, 'summary').out, /余额 70 分/)
    assert.equal(run(dir, 'doctor').code, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('回收和核销的连续冲正正确恢复券状态', () => {
  const dir = makeDataDir()
  try {
    assert.equal(run(dir, 'earn', '攒分', '100').code, 0)
    assert.equal(run(dir, 'redeem', 'lazy').code, 0)
    const voucher = findId(dir, 'redeem_voucher')
    assert.equal(run(dir, 'recycle', voucher).code, 0)
    const recycle = findId(dir, 'recycle_voucher')
    assert.equal(run(dir, 'adjust', '--ref', recycle).code, 0)
    const undoRecycle = findAdjustmentFor(dir, recycle)
    assert.match(run(dir, 'summary').out, /背包 1 张券/)
    assert.equal(run(dir, 'adjust', '--ref', undoRecycle).code, 0)
    assert.match(run(dir, 'summary').out, /余额 94 分.*背包 0 张券/)
    const duplicateRecycle = run(dir, 'recycle', voucher)
    assert.notEqual(duplicateRecycle.code, 0)
    assert.match(duplicateRecycle.out, /不能重复操作/)
    assert.equal(run(dir, 'doctor').code, 0)

    assert.equal(run(dir, 'redeem', 'lazy').code, 0)
    const voucher2 = [...run(dir, 'list', '--limit', '100').out.matchAll(/\[redeem_voucher\] (\S+)/g)]
      .map((match) => match[1]).find((id) => id !== voucher)
    assert.ok(voucher2)
    assert.equal(run(dir, 'use', voucher2).code, 0)
    const use = findId(dir, 'use_voucher')
    assert.equal(run(dir, 'adjust', '--ref', use).code, 0)
    const undoUse = findAdjustmentFor(dir, use)
    assert.equal(run(dir, 'adjust', '--ref', undoUse).code, 0)
    assert.notEqual(run(dir, 'use', voucher2).code, 0)
    assert.equal(run(dir, 'doctor').code, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('重复 id、无效 ref 和重复有效消费均阻止写账', () => {
  for (const corruption of ['duplicate', 'missing-ref', 'double-use']) {
    const dir = makeDataDir()
    try {
      assert.equal(run(dir, 'earn', '攒分', '100').code, 0)
      assert.equal(run(dir, 'redeem', 'lazy').code, 0)
      const voucher = findId(dir, 'redeem_voucher')
      if (corruption === 'duplicate') putFixture(dir, fixture(voucher, 'redeem_voucher', -30, 0))
      if (corruption === 'missing-ref') putFixture(dir, fixture('missing-ref', 'adjust', 5, 0, 'no-such-id'))
      if (corruption === 'double-use') {
        assert.equal(run(dir, 'use', voucher).code, 0)
        putFixture(dir, fixture('second-use', 'use_voucher', 0, 0, voucher))
      }
      const doctor = run(dir, 'doctor')
      assert.notEqual(doctor.code, 0, corruption)
      assert.match(doctor.out, /重复 id|不存在的 ref|核销\/回收了 2 次/)
      for (const cmd of [['earn', '更多', '5'], ['redeem', 'lazy'], ['summary']]) {
        const result = run(dir, ...cmd)
        assert.notEqual(result.code, 0, `${corruption}: ${result.out}`)
        assert.match(result.out, /账本存在问题/)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('部分退款后的券按当前实付回收，重复零值冲正会被拒绝', () => {
  const dir = makeDataDir()
  try {
    assert.equal(run(dir, 'earn', '攒分', '100').code, 0)
    assert.equal(run(dir, 'redeem', 'lazy').code, 0)
    const voucher = findId(dir, 'redeem_voucher')
    assert.equal(run(dir, 'adjust', '--ref', voucher, '--points', '10').code, 0)
    const recycled = run(dir, 'recycle', voucher)
    assert.equal(recycled.code, 0, recycled.out)
    assert.match(recycled.out, /回收成功.*\+16 分/)
    assert.match(run(dir, 'summary').out, /余额 96 分/)
    assert.equal(run(dir, 'doctor').code, 0)

    assert.equal(run(dir, 'redeem', 'lazy').code, 0)
    const voucher2 = [...run(dir, 'list', '--limit', '100').out.matchAll(/\[redeem_voucher\] (\S+)/g)]
      .map((match) => match[1]).find((id) => id !== voucher)
    assert.ok(voucher2)
    assert.equal(run(dir, 'use', voucher2).code, 0)
    const use = findId(dir, 'use_voucher')
    assert.equal(run(dir, 'adjust', '--ref', use).code, 0)
    const second = run(dir, 'adjust', '--ref', use)
    assert.notEqual(second.code, 0)
    assert.match(second.out, /已被全额冲正/)
    assert.equal(run(dir, 'doctor').code, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('已消费券的更正子树不能继续退款', () => {
  for (const action of ['use', 'recycle']) {
    const dir = makeDataDir()
    try {
      assert.equal(run(dir, 'earn', '攒分', '100').code, 0)
      assert.equal(run(dir, 'redeem', 'lazy').code, 0)
      const voucher = findId(dir, 'redeem_voucher')
      assert.equal(run(dir, 'adjust', '--ref', voucher, '--points', '10').code, 0)
      const refund = findAdjustmentFor(dir, voucher)
      assert.equal(run(dir, action, voucher).code, 0)
      const attempt = run(dir, 'adjust', '--ref', refund, '--points', '10')
      assert.notEqual(attempt.code, 0)
      assert.match(attempt.out, /已被有效核销\/回收，不能再更正兑换金额/)
      assert.equal(run(dir, 'doctor').code, 0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('doctor 检出人为添加的重复零值冲正', () => {
  const dir = makeDataDir()
  try {
    assert.equal(run(dir, 'earn', '攒分', '100').code, 0)
    assert.equal(run(dir, 'redeem', 'lazy').code, 0)
    const voucher = findId(dir, 'redeem_voucher')
    assert.equal(run(dir, 'use', voucher).code, 0)
    const use = findId(dir, 'use_voucher')
    assert.equal(run(dir, 'adjust', '--ref', use).code, 0)
    putFixture(dir, fixture('second-zero-adjust', 'adjust', 0, 0, use))
    const doctor = run(dir, 'doctor')
    assert.notEqual(doctor.code, 0)
    assert.match(doctor.out, /零值记录.*被有效冲正了 2 次/)
    assert.notEqual(run(dir, 'earn', '更多', '5').code, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('doctor 检出部分退款后按原价过量回收的历史记录', () => {
  const dir = makeDataDir()
  try {
    assert.equal(run(dir, 'earn', '攒分', '100').code, 0)
    assert.equal(run(dir, 'redeem', 'lazy').code, 0)
    const voucher = findId(dir, 'redeem_voucher')
    assert.equal(run(dir, 'adjust', '--ref', voucher, '--points', '10').code, 0)
    putFixture(dir, fixture('excess-refund', 'recycle_voucher', 24, 0, voucher))
    const doctor = run(dir, 'doctor')
    assert.notEqual(doctor.code, 0)
    assert.match(doctor.out, /返还 24 分，超过.*可返的 16 分/)
    assert.notEqual(run(dir, 'earn', '更多', '5').code, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('过期但持有者仍存活的写锁不能被抢占', () => {
  const dir = makeDataDir()
  try {
    const lock = join(dir, '.ledger.lock')
    const owner = { pid: process.pid, host: hostname(), token: 'live-owner' }
    writeFileSync(lock, JSON.stringify(owner))
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    const attempt = run(dir, 'earn', '测试', '5')
    assert.notEqual(attempt.code, 0)
    assert.match(attempt.out, /获取写锁超时/)
    assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, owner.token)
    assert.match(run(dir, 'summary').out, /余额 0 分/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('已退出持有者的陈旧锁可被清理，且新写锁正常释放', () => {
  const dir = makeDataDir()
  try {
    const exited = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
    assert.equal(exited.status, 0)
    const lock = join(dir, '.ledger.lock')
    writeFileSync(lock, JSON.stringify({ pid: Number(exited.stdout.trim()), host: hostname(), token: 'dead-owner' }))
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    const result = run(dir, 'earn', '测试', '5')
    assert.equal(result.code, 0, result.out)
    assert.match(result.out, /已确认写锁持有进程退出/)
    assert.match(run(dir, 'summary').out, /余额 5 分/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('极大或非整数积分被拒绝，安全整数经验可快速计算等级', () => {
  const dir = makeDataDir()
  try {
    for (const points of ['1e308', '0.5', String(Number.MAX_SAFE_INTEGER + 1)]) {
      const result = run(dir, 'earn', '异常', points)
      assert.notEqual(result.code, 0)
      assert.match(result.out, /安全整数/)
    }
    const max = String(Number.MAX_SAFE_INTEGER)
    const accepted = run(dir, 'earn', '上限', max)
    assert.equal(accepted.code, 0, accepted.out)
    assert.match(accepted.out, new RegExp(`余额 ${max} 分`))
    const overflow = run(dir, 'earn', '溢出', '1')
    assert.notEqual(overflow.code, 0)
    assert.match(overflow.out, /累计积分变动超过安全整数范围/)
    assert.equal(run(dir, 'doctor').code, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('商城定价必须能换算为安全整数积分', () => {
  const dir = makeDataDir()
  try {
    writeFileSync(join(dir, 'shop.json'), JSON.stringify({ items: [
      { id: 'fraction', name: '小数券', type: 'voucher', points: 0.5 },
      { id: 'huge', name: '过大实物', type: 'physical', yuan: 1e308 },
    ] }))
    const voucher = run(dir, 'redeem', 'fraction')
    assert.notEqual(voucher.code, 0)
    assert.match(voucher.out, /正安全整数/)
    const physical = run(dir, 'redeem', 'huge')
    assert.notEqual(physical.code, 0)
    assert.match(physical.out, /超出安全整数范围/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
