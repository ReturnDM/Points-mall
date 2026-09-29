#!/usr/bin/env node
/**
 * 初始化数据目录：拷贝价目表和商品模板，并创建空账本目录。
 * 路径解析：环境变量 POINTS_DATA_DIR > config.local.json 的 dataDir > 报错提示。
 * 已存在的文件不会被覆盖。
 */
import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function resolveDataDir() {
  if (process.env.POINTS_DATA_DIR) return resolve(process.env.POINTS_DATA_DIR)
  const cfg = join(root, 'config.local.json')
  if (existsSync(cfg)) {
    try {
      const { dataDir } = JSON.parse(readFileSync(cfg, 'utf8'))
      if (dataDir) return resolve(dataDir)
    } catch { /* fallthrough */ }
  }
  console.error('未配置数据目录。两种方式任选：\n  1. 设置环境变量 POINTS_DATA_DIR\n  2. 在项目根目录创建 config.local.json：{ "dataDir": "D:\\Nutstore\\积分商城数据" }')
  process.exit(1)
}

function copyTemplate(name, dest) {
  const source = join(root, 'seed', name)
  const target = join(dest, name)
  if (!existsSync(target)) {
    copyFileSync(source, target)
    console.log('写入', target)
  } else {
    console.log('已存在，跳过', target)
  }
}

const dataDir = resolveDataDir()
mkdirSync(dataDir, { recursive: true })
for (const name of ['tasks.json', 'shop.json']) copyTemplate(name, dataDir)
mkdirSync(join(dataDir, 'ledger'), { recursive: true })
console.log('数据目录初始化完成：', dataDir)
