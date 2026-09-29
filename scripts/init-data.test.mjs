import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const initCli = join(projectRoot, 'scripts', 'init-data.mjs')
const ledgerCli = join(projectRoot, 'scripts', 'ledger.mjs')

function run(cli, dataDir, ...args) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, POINTS_DATA_DIR: dataDir },
    encoding: 'utf8',
  })
}

test('首次初始化从零余额开始，重复初始化保留已有数据', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'points-init-test-'))
  const dataDir = join(tempRoot, 'data')
  try {
    const first = run(initCli, dataDir)
    assert.equal(first.status, 0, first.stderr)
    assert.deepEqual(readdirSync(dataDir).sort(), ['ledger', 'shop.json', 'tasks.json'])
    assert.deepEqual(readdirSync(join(dataDir, 'ledger')), [])
    for (const name of ['tasks.json', 'shop.json']) {
      assert.equal(
        readFileSync(join(dataDir, name), 'utf8'),
        readFileSync(join(projectRoot, 'seed', name), 'utf8'),
      )
    }

    const summary = run(ledgerCli, dataDir, 'summary')
    assert.equal(summary.status, 0, summary.stderr)
    assert.match(summary.stdout, /余额 0 分/)
    assert.match(summary.stdout, /累计经验 0/)

    const customShop = '{"items":[]}'
    writeFileSync(join(dataDir, 'shop.json'), customShop)
    const existingEntry = {
      id: '20260925-120000-existing', time: '2026-09-25T12:00:00+08:00',
      type: 'earn', title: '已有记录', points: 7, exp: 7,
    }
    const entryPath = join(dataDir, 'ledger', `${existingEntry.id}.json`)
    writeFileSync(entryPath, JSON.stringify(existingEntry))

    const second = run(initCli, dataDir)
    assert.equal(second.status, 0, second.stderr)
    assert.equal(readFileSync(join(dataDir, 'shop.json'), 'utf8'), customShop)
    assert.deepEqual(JSON.parse(readFileSync(entryPath, 'utf8')), existingEntry)
    assert.deepEqual(readdirSync(join(dataDir, 'ledger')), [`${existingEntry.id}.json`])
  } finally {
    assert.equal(dirname(tempRoot), tmpdir())
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
