import type { DataBundle, LedgerEntry, ShopItem, TaskPricing } from './types'

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

/** 递归收集 ledger/ 下所有 .json 流水（支持按年/月子目录拆分） */
async function collectLedger(ledgerDir: DirHandle, warnings: string[]): Promise<LedgerEntry[]> {
  const out: LedgerEntry[] = []
  for await (const entry of ledgerDir.entries() as AsyncIterable<DirEntry>) {
    const [name, handle] = entry
    try {
      if (handle.kind === 'directory') {
        out.push(...(await collectLedger(handle, warnings)))
      } else if (name.endsWith('.json') && !name.endsWith('.tmp')) {
        const data = (await readJson(await handle.getFile!())) as LedgerEntry
        if (data && typeof data.id === 'string' && typeof data.points === 'number') {
          out.push(data)
        } else {
          warnings.push(`流水文件格式异常：ledger/${name}`)
        }
      }
    } catch (err) {
      warnings.push(`读取 ledger/${name} 失败：${String(err)}`)
    }
  }
  return out
}

export async function readBundle(dir: DirHandle): Promise<DataBundle> {
  const warnings: string[] = []
  let shop: ShopItem[] = []
  let pricing: TaskPricing | null = null
  const entries: LedgerEntry[] = []

  for (const name of ['shop.json', 'tasks.json']) {
    try {
      const fh = await dir.getFileHandle(name)
      const data = await readJson(await fh.getFile())
      if (name === 'shop.json') shop = Array.isArray(data) ? (data as ShopItem[]) : (((data as { items?: ShopItem[] })?.items) ?? [])
      else pricing = data as TaskPricing
    } catch {
      warnings.push(`缺少或无法读取 ${name}`)
    }
  }

  try {
    const ledgerDir = await dir.getDirectoryHandle('ledger')
    entries.push(...(await collectLedger(ledgerDir, warnings)))
  } catch {
    warnings.push('缺少 ledger/ 目录（还没有任何记账）')
  }

  return { entries, shop, pricing, warnings }
}

export function fsAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}
