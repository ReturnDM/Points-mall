// CLI 冒烟测试：node --test scripts/ledger.test.mjs（需 Node 20+）
// 在临时数据目录上跑真实 CLI，验证写账主路径与防重护栏。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  })
  return { code: r.status, out: r.stdout + r.stderr }
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
