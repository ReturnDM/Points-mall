#!/usr/bin/env node
/**
 * 初始化数据目录：把 seed/ 里的示例文件拷到 POINTS_DATA_DIR（坚果云同步目录）。
 * 路径解析：环境变量 POINTS_DATA_DIR > config.local.json 的 dataDir > 报错提示。
 * 已存在的文件不会被覆盖。
 */
import { existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs'
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

function copySeed(src, dest) {
  for (const name of readdirSync(src)) {
    const s = join(src, name)
    const d = join(dest, name)
    if (statSync(s).isDirectory()) {
      mkdirSync(d, { recursive: true })
      copySeed(s, d)
    } else if (!existsSync(d)) {
      copyFileSync(s, d)
      console.log('写入', d)
    } else {
      console.log('已存在，跳过', d)
    }
  }
}

const dataDir = resolveDataDir()
mkdirSync(dataDir, { recursive: true })
copySeed(join(root, 'seed'), dataDir)
console.log('数据目录初始化完成：', dataDir)
