import type { DataBundle } from './types'

/** 演示模式：?demo 从 public/demo/ 读取示例数据，无需授权目录 */
export async function loadDemoBundle(): Promise<DataBundle> {
  const [shop, tasks, ledger] = await Promise.all([
    fetch('demo/shop.json').then((r) => r.json()),
    fetch('demo/tasks.json').then((r) => r.json()),
    fetch('demo/ledger.json').then((r) => r.json()),
  ])
  return {
    entries: ledger,
    shop: shop.items ?? shop,
    pricing: tasks,
    rate: 20,
    readAt: new Date().toISOString(),
    dirName: '演示数据',
    warnings: ['演示模式：数据来自项目内置示例，刷新或部署后可换成真实目录'],
  }
}
