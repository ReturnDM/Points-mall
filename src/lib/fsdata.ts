import type { DataBundle, LedgerEntry, ShopItem, TaskPricing } from './types'
import { entryErrors } from '../../shared/entry-schema.mjs'
import { ledgerErrors } from '../../shared/ledger-state.mjs'

/**
 * 浏览器端数据读取：File System Access API 选择/授权坚果云数据目录（只读）。
 * 目录结构：
 *   <数据目录>/
 *     shop.json
 *     tasks.json
 *     ledger/**\/*.json   （每笔流水一个文件，递归读取）
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DirHandle = any
type DirEntry = [string, { kind: 'file' | 'directory'; getFile?: () => Promise<File> }]

const DB_NAME = 'points-mall-fs'
const STORE = 'handles'

async function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}

export async function saveDirHandle(handle: DirHandle): Promise<void> {
  const db = await idb()
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(handle, 'datadir')
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}

export async function loadDirHandle(): Promise<DirHandle | null> {
  const db = await idb()
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get('datadir')
    req.onsuccess = () => res(req.result ?? null)
    req.onerror = () => rej(req.error)
  })
}

/** 已记住目录时，尝试无提示续权；返回 null 表示需要用户点一次按钮重新授权 */
export async function ensurePermission(handle: DirHandle): Promise<boolean> {
  if (!handle) return false
  const opts = { mode: 'read' as const }
  if ((await handle.queryPermission(opts)) === 'granted') return true
  return (await handle.requestPermission(opts)) === 'granted'
}

async function readJson(file: File): Promise<unknown> {
  const text = await file.text()
  return JSON.parse(text)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function positivePoints(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function describeReadError(err: unknown): string {
  if (err instanceof SyntaxError) return 'JSON 格式错误'
  if (err instanceof DOMException) return err.name === 'NotFoundError' ? '文件或目录不存在' : '文件无法读取'
  return err instanceof Error ? err.message : '文件无法读取'
}

function parseShop(data: unknown): ShopItem[] {
  // 兼容旧的数组格式；新格式为 { items: [...] }。
  const items = Array.isArray(data) ? data : isRecord(data) ? data.items : undefined
  if (!Array.isArray(items)) throw new Error('应包含 items 数组')
  const ids = new Set<string>()
  for (const [i, item] of items.entries()) {
    if (!isRecord(item) || !nonEmptyString(item.id) || !nonEmptyString(item.name))
      throw new Error(`第 ${i + 1} 个商品缺少有效的 id 或 name`)
    if (ids.has(item.id)) throw new Error(`商品 id 重复：${item.id}`)
    ids.add(item.id)
    if (item.type !== 'voucher' && item.type !== 'physical')
      throw new Error(`商品 ${item.id} 的 type 应为 voucher 或 physical`)
    if (item.type === 'voucher' && !positivePoints(item.points))
      throw new Error(`商品 ${item.id} 的 points 应为正整数`)
    if (item.type === 'physical' && !positiveNumber(item.yuan))
      throw new Error(`商品 ${item.id} 的 yuan 应为正数`)
    if (!optionalString(item.desc) || !optionalString(item.emoji))
      throw new Error(`商品 ${item.id} 的 desc/emoji 应为文字`)
  }
  return items as ShopItem[]
}

function parsePricing(data: unknown): TaskPricing {
  if (!isRecord(data) || !Array.isArray(data.tiers) || !Array.isArray(data.tasks))
    throw new Error('应包含 tiers 和 tasks 数组')
  const tiers = data.tiers
  if (tiers.length === 0 || tiers.some((tier, i) => !positivePoints(tier) || (i > 0 && tier <= tiers[i - 1])))
    throw new Error('tiers 应为从小到大排列的正整数档位')
  const ids = new Set<string>()
  for (const [i, task] of data.tasks.entries()) {
    if (!isRecord(task) || !nonEmptyString(task.id) || !nonEmptyString(task.name))
      throw new Error(`第 ${i + 1} 个事项缺少有效的 id 或 name`)
    if (ids.has(task.id)) throw new Error(`事项 id 重复：${task.id}`)
    ids.add(task.id)
    if (!positivePoints(task.points)) throw new Error(`事项 ${task.id} 的 points 应为正整数`)
    if (!optionalString(task.emoji)) throw new Error(`事项 ${task.id} 的 emoji 应为文字`)
  }
  return data as unknown as TaskPricing
}

/** 递归收集 ledger/ 下所有 .json 流水（支持按年/月子目录拆分） */
async function collectLedger(ledgerDir: DirHandle, problems: string[], path = 'ledger'): Promise<LedgerEntry[]> {
  const out: LedgerEntry[] = []
  for await (const entry of ledgerDir.entries() as AsyncIterable<DirEntry>) {
    const [name, handle] = entry
    const filePath = `${path}/${name}`
    try {
      if (handle.kind === 'directory') {
        out.push(...(await collectLedger(handle, problems, filePath)))
      } else if (name.endsWith('.json')) {
        const data = await readJson(await handle.getFile!())
        const errs = entryErrors(data)
        if (errs.length > 0) {
          problems.push(`${filePath} 校验失败：${errs.join('；')}`)
        } else if ((data as LedgerEntry).id !== name.slice(0, -5)) {
          problems.push(`${filePath} 的文件名与记录 id 不一致`)
        } else {
          out.push(data as LedgerEntry)
        }
      }
    } catch (err) {
      problems.push(`读取 ${filePath} 失败：${describeReadError(err)}`)
    }
  }
  return out
}

export async function readBundle(dir: DirHandle): Promise<DataBundle> {
  const warnings: string[] = []
  const ledgerProblems: string[] = []
  let shop: ShopItem[] = []
  let pricing: TaskPricing | null = null
  let shopError: string | undefined
  let pricingError: string | undefined
  let rate = 20
  const entries: LedgerEntry[] = []

  for (const name of ['shop.json', 'tasks.json', 'config.json']) {
    try {
      const fh = await dir.getFileHandle(name)
      const data = await readJson(await fh.getFile())
      if (name === 'shop.json') shop = parseShop(data)
      else if (name === 'tasks.json') pricing = parsePricing(data)
      else {
        const r = (data as { physicalRate?: number })?.physicalRate
        if (Number.isFinite(r) && (r as number) > 0) rate = r as number
        else if (r !== undefined) warnings.push('config.json 的 physicalRate 无效，使用默认汇率 20 分 = 1 元')
      }
    } catch (err) {
      if (name === 'shop.json') shopError = `shop.json：${describeReadError(err)}`
      else if (name === 'tasks.json') pricingError = `tasks.json：${describeReadError(err)}`
    }
  }

  let rulesMarkdown: string | undefined
  try {
    const fh = await dir.getFileHandle('积分规则.md')
    rulesMarkdown = await (await fh.getFile()).text()
  } catch { /* 可选文件 */ }

  try {
    const ledgerDir = await dir.getDirectoryHandle('ledger')
    entries.push(...(await collectLedger(ledgerDir, ledgerProblems)))
  } catch (err) {
    ledgerProblems.push(`无法读取 ledger/ 目录：${describeReadError(err)}`)
  }
  try {
    ledgerProblems.push(...ledgerErrors(entries))
  } catch {
    ledgerProblems.push('账本校验失败，请通过 CLI 检查数据')
  }

  return {
    entries,
    shop,
    pricing,
    shopError,
    pricingError,
    ledgerErrors: ledgerProblems,
    rate,
    rulesMarkdown,
    readAt: new Date().toISOString(),
    dirName: typeof dir.name === 'string' ? dir.name : undefined,
    warnings,
  }
}

export function fsAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}
