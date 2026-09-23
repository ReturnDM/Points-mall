import { useCallback, useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, Coins, Star, Package, PencilRuler, AlertTriangle } from 'lucide-react'
import type { DataBundle, LedgerEntry, ShopItem } from './lib/types'
import { readBundle, loadDirHandle, saveDirHandle, ensurePermission, fsAccessSupported } from './lib/fsdata'
import { summarize, sortEntries, recycleValue, yuanToPoints } from './lib/ledger'
import { loadDemoBundle } from './lib/demo'
import { Card, WobblyButton, StickyTag, SectionTitle } from './ui'

export default function App() {
  const [bundle, setBundle] = useState<DataBundle | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState('')
  const [pickSupported] = useState(fsAccessSupported)

  const [dirRef, setDirRef] = useState<unknown>(null)

  const load = useCallback(async (dir: unknown) => {
    setDirRef(dir)
    try {
      const data = await readBundle(dir)
      setBundle(data)
      setStatus('ready')
    } catch (e) {
      setError(String(e))
      setStatus('error')
    }
  }, [])

  const pick = useCallback(async () => {
    try {
      // @ts-expect-error window.showDirectoryPicker 由 FS Access API 提供
      const dir = await window.showDirectoryPicker({ mode: 'read' })
      await saveDirHandle(dir)
      await load(dir)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError(String(e))
        setStatus('error')
      }
    }
  }, [load])

  useEffect(() => {
    ;(async () => {
      if (new URLSearchParams(location.search).has('demo')) {
        setBundle(await loadDemoBundle())
        setStatus('ready')
        return
      }
      const dir = await loadDirHandle()
      if (dir && (await ensurePermission(dir))) await load(dir)
    })()
  }, [load])

  // 自动刷新：窗口重新获得焦点时，以及每 60 秒兜底轮询一次
  useEffect(() => {
    if (!dirRef) return
    const onFocus = () => load(dirRef)
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(onFocus, 60_000)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.clearInterval(timer)
    }
  }, [dirRef, load])

  const summary = bundle ? summarize(bundle.entries) : null

  return (
    <div className="min-h-screen px-6 py-10 max-w-5xl mx-auto">
      <Header onPick={pick} onReload={() => dirRef && load(dirRef)} hasData={!!summary} pickSupported={pickSupported} />
      {status === 'idle' && <Welcome onPick={pick} pickSupported={pickSupported} />}
      {status === 'loading' && <p className="text-xl text-center py-20">正在翻账本…</p>}
      {status === 'error' && (
        <Card className="p-6 text-center text-accent">
          <p className="text-xl">读取失败：{error}</p>
          <WobblyButton className="mt-4" onClick={pick}>重新选择数据目录</WobblyButton>
        </Card>
      )}
      {status === 'ready' && bundle && summary && (
        <main className="space-y-16">
          <TrustBanner bundle={bundle} onPick={pick} />
          {bundle.entries.length === 0 ? (
            <Card className="p-8 text-center border-dashed">
              <AlertTriangle className="mx-auto mb-3 text-accent" size={40} strokeWidth={2.5} />
              <p className="text-xl">没有读到任何流水 —— 下方的余额 / 等级不可信</p>
              <p className="mt-2 opacity-60">可能是选错了目录，或账本还没有第一笔记录。检查目录名或重新选择。</p>
            </Card>
          ) : (
            <>
              <Dashboard points={summary.points} exp={summary.exp} level={summary.level} backpackCount={summary.backpack.length} rate={bundle.rate} />
              <Tasks pricing={bundle.pricing} />
              <Shop shop={bundle.shop} points={summary.points} rate={bundle.rate} />
              <Backpack backpack={summary.backpack} />
              <LedgerList entries={sortEntries(bundle.entries)} />
            </>
          )}
        </main>
      )}
      <footer className="mt-20 text-center text-sm opacity-50 border-t-2 border-dashed border-ink/30 pt-6">
        纯静态只读前端 · 写入请找 Agent（CLI）· 坚果云同步数据目录
      </footer>
    </div>
  )
}

function Header({ onPick, onReload, hasData, pickSupported }: { onPick: () => void; onReload: () => void; hasData: boolean; pickSupported: boolean }) {
  return (
    <header className="mb-12 flex flex-wrap items-center justify-between gap-4">
      <h1 className="text-4xl md:text-5xl font-bold -rotate-1">
        积分商城 <span className="inline-block rotate-6 text-accent">✏️</span>
      </h1>
      <div className="flex gap-3">
        <WobblyButton variant="secondary" onClick={onPick} disabled={!pickSupported}>
          <FolderOpen strokeWidth={2.5} size={20} /> 选择数据目录
        </WobblyButton>
        {hasData && (
          <WobblyButton variant="secondary" onClick={onReload}>
            <RefreshCw strokeWidth={2.5} size={20} /> 刷新
          </WobblyButton>
        )}
      </div>
      {!pickSupported && (
        <p className="w-full text-sm text-accent">
          当前浏览器不支持 File System Access API，请使用 Edge / Chrome 打开（刷新时需重新授权目录）。
        </p>
      )}
    </header>
  )
}

/** 可信度横幅：数据目录名 + 读取时间 + 警告，置于总览上方 */
function TrustBanner({ bundle, onPick }: { bundle: DataBundle; onPick: () => void }) {
  const readTime = new Date(bundle.readAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const hasCritical = bundle.entries.length === 0
  return (
    <div className={`border-2 border-dashed ${hasCritical ? 'border-accent text-accent' : 'border-ink/30'} wobbly-sm px-4 py-2 text-sm flex flex-wrap items-center gap-x-4 gap-y-1`}>
      <span>📂 {bundle.dirName ?? '已授权目录'}</span>
      <span className="opacity-60">读取于 {readTime} · 切回页面会自动刷新</span>
      {bundle.warnings.length > 0 && (
        <span className="basis-full">
          {bundle.warnings.map((w, i) => (
            <span key={i} className="block">⚠ {w}</span>
          ))}
        </span>
      )}
      {hasCritical && (
        <WobblyButton variant="secondary" className="!h-9 !px-4 text-sm" onClick={onPick}>
          重新选择目录
        </WobblyButton>
      )}
    </div>
  )
}

function Welcome({ onPick, pickSupported }: { onPick: () => void; pickSupported: boolean }) {
  return (
    <Card decoration="tape" className="p-8 md:p-10 text-center rotate-1">
      <PencilRuler className="mx-auto mb-4 bob" size={48} strokeWidth={2.5} />
      <p className="text-lg md:text-xl leading-relaxed max-w-xl mx-auto">
        这是纯静态只读积分商城。先在浏览器里选择坚果云数据目录（只读授权），
        网页会读取流水 JSON 汇总出积分、经验和等级。
        <br />
        记账 / 兑换 / 核销 / 回收都通过对话让 Agent 写入。
      </p>
      <WobblyButton className="mt-8 text-xl" onClick={onPick} disabled={!pickSupported}>
        <FolderOpen strokeWidth={3} size={22} /> 选择数据目录开始
      </WobblyButton>
    </Card>
  )
}

function Dashboard({ points, exp, level, backpackCount, rate }: { points: number; exp: number; level: { level: number; expInLevel: number; expToNext: number; expRequired: number }; backpackCount: number; rate: number }) {
  const pct = Math.min(100, Math.round((level.expInLevel / level.expRequired) * 100))
  return (
    <section aria-label="总览">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <Card decoration="tack" className="p-6 text-center md:-rotate-1">
          <Coins className="mx-auto mb-2" size={32} strokeWidth={2.5} />
          <p className="text-sm opacity-60">当前积分</p>
          <p className="text-5xl font-bold text-accent">{points}</p>
          <p className="mt-1 text-sm opacity-60">≈ ¥{(points / rate).toFixed(1)}（{rate} 分 = 1 元）</p>
        </Card>
        <Card className="p-6 md:rotate-1" style={{ background: '#fff' }}>
          <Star className="mx-auto mb-2" size={32} strokeWidth={2.5} />
          <p className="text-sm opacity-60">等级</p>
          <p className="text-5xl font-bold text-pen">Lv.{level.level}</p>
          <div className="mt-3 progress-track wobbly-sm border-2 border-ink h-5 overflow-hidden">
            <div className="h-full bg-pen/70" style={{ width: `${pct}%`, borderRadius: '25px 10px 20px 10px / 10px 20px 10px 25px' }} />
          </div>
          <p className="mt-2 text-sm">
            {level.expInLevel} / {level.expRequired} · 还差 {level.expToNext} 经验升级
          </p>
        </Card>
        <Card className="p-6 text-center md:rotate-2" postit>
          <Package className="mx-auto mb-2" size={32} strokeWidth={2.5} />
          <p className="text-sm opacity-60">背包里的券</p>
          <p className="text-5xl font-bold">{backpackCount}</p>
          <p className="mt-1 text-sm opacity-60">未核销可按 80% 回收</p>
        </Card>
      </div>
      <p className="mt-4 text-center text-sm opacity-50">累计经验 {exp}（只增不减，花积分不掉级）</p>
    </section>
  )
}

function Tasks({ pricing }: { pricing: { tiers: number[]; tasks: { id: string; name: string; points: number; emoji?: string }[] } | null }) {
  return (
    <section aria-label="价目表">
      <SectionTitle sub="档位制，Agent 定档记账">价目表</SectionTitle>
      {!pricing ? (
        <Card className="p-6 text-center opacity-60">数据目录里还没有 tasks.json</Card>
      ) : (
        <div className="flex flex-wrap gap-4 mb-6">
          {pricing.tiers.map((t, i) => (
            <div
              key={t}
              className="border-[3px] border-ink bg-white shadow-hard px-5 py-3 wobbly-blob text-center pressable"
              style={{ transform: `rotate(${(i % 2 === 0 ? -1 : 1) * 2}deg)` }}
            >
              <span className="text-2xl font-bold">{t}</span>
              <span className="text-xs opacity-50 ml-1">分</span>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {pricing?.tasks.map((task, i) => (
          <Card key={task.id} className="p-4 flex items-center justify-between" decoration={i % 3 === 1 ? 'tape' : undefined}>
            <span className="text-lg">
              {task.emoji ? `${task.emoji} ` : ''}{task.name}
            </span>
            <StickyTag>+{task.points} 分</StickyTag>
          </Card>
        ))}
      </div>
    </section>
  )
}

function Shop({ shop, points, rate }: { shop: ShopItem[]; points: number; rate: number }) {
  return (
    <section aria-label="商城">
      <SectionTitle sub={`双轨定价：实物 ${rate} 分 = 1 元，虚拟券独立定价`}>商城</SectionTitle>
      {shop.length === 0 ? (
        <Card className="p-6 text-center opacity-60">数据目录里还没有 shop.json，商品清单由 Agent 添加</Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {shop.map((item, i) => {
            const price = item.type === 'voucher' ? (item.points ?? 0) : yuanToPoints(item.yuan ?? 0, rate)
            const affordable = points >= price
            return (
              <Card
                key={item.id}
                postit={item.type === 'voucher'}
                decoration={i % 2 === 0 ? 'tape' : 'tack'}
                className={`p-6 hover:rotate-1 transition-transform duration-100 ${affordable ? '' : 'opacity-70'}`}
              >
                <div className="text-4xl mb-2">{item.emoji ?? (item.type === 'voucher' ? '🎟️' : '📦')}</div>
                <h3 className="text-xl font-bold">{item.name}</h3>
                {item.desc && <p className="mt-1 text-sm opacity-60">{item.desc}</p>}
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-2xl font-bold text-accent">{price} 分</span>
                  {item.type === 'physical' && item.yuan != null && (
                    <span className="text-xs opacity-50">¥{item.yuan} × {rate}</span>
                  )}
                </div>
                {!affordable && <p className="mt-2 text-sm text-pen">还差 {price - points} 分</p>}
                {item.type === 'voucher' && (
                  <p className="mt-2 text-xs opacity-50 border-t border-dashed border-ink/30 pt-2">
                    兑换后入背包 · 未核销可回收 {recycleValue(price)} 分
                  </p>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </section>
  )
}

function Backpack({ backpack }: { backpack: LedgerEntry[] }) {
  return (
    <section aria-label="背包">
      <SectionTitle sub="核销不再扣积分；回收返还原实付 80%">背包</SectionTitle>
      {backpack.length === 0 ? (
        <Card className="p-6 text-center opacity-60">背包空空如也，去商城兑换点券吧</Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {backpack.map((c, i) => (
            <Card key={c.id} className={`p-5 flex items-center justify-between ${i % 2 ? 'rotate-1' : '-rotate-1'}`} postit>
              <div>
                <p className="text-lg font-bold">🎟️ {c.title}</p>
                <p className="text-sm opacity-60">
                  兑换于 {new Date(c.time).toLocaleDateString('zh-CN')} · 实付 {c.points * -1} 分
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm">待核销</p>
                <p className="text-xs opacity-50">回收可得 {recycleValue(c.points * -1)} 分</p>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  )
}

function LedgerList({ entries }: { entries: LedgerEntry[] }) {
  const [showAll, setShowAll] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const typeLabel: Record<string, { text: string; cls: string }> = {
    earn: { text: '获得', cls: 'text-accent' },
    redeem_physical: { text: '兑换实物', cls: 'text-pen' },
    redeem_voucher: { text: '兑换券', cls: 'text-pen' },
    use_voucher: { text: '核销', cls: 'opacity-60' },
    recycle_voucher: { text: '回收', cls: 'text-accent' },
    adjust: { text: '更正', cls: 'opacity-60' },
  }
  const shown = showAll ? entries : entries.slice(0, 50)
  return (
    <section aria-label="流水">
      <SectionTitle sub="余额与等级均由流水汇总，改账不覆盖历史">流水账本</SectionTitle>
      {entries.length === 0 ? (
        <Card className="p-6 text-center opacity-60">还没有流水 —— 跟 Agent 说一句「刷了牙」试试</Card>
      ) : (
        <Card className="divide-y-2 divide-dashed divide-ink/20">
          {shown.map((e) => {
            const t = typeLabel[e.type] ?? { text: e.type, cls: '' }
            const hasDetail = !!(e.note || e.ref)
            const open = expanded.has(e.id)
            return (
              <div
                key={e.id}
                className={`flex items-start justify-between px-5 py-3 gap-4 ${hasDetail ? 'cursor-pointer hover:bg-muted/30' : ''}`}
                onClick={hasDetail ? () => toggle(e.id) : undefined}
              >
                <div className="min-w-0">
                  <p className={open ? '' : 'truncate'}>
                    <span className={`text-sm mr-2 ${t.cls}`}>[{t.text}]</span>
                    {e.title}
                  </p>
                  {e.note && <p className={`text-sm opacity-50 ${open ? '' : 'truncate'}`}>✎ {e.note}</p>}
                  {open && e.ref && <p className="text-xs opacity-40 mt-0.5">↳ 关联记录：{e.ref}</p>}
                  {hasDetail && <p className="text-xs opacity-30 mt-0.5">{open ? '▲ 收起' : '▼ 展开详情'}</p>}
                </div>
                <div className="text-right shrink-0">
                  <p className={`font-bold ${e.points > 0 ? 'text-accent' : e.points < 0 ? 'text-pen' : 'opacity-60'}`}>
                    {e.points >= 0 ? '+' : ''}{e.points} 分
                  </p>
                  <p className="text-xs opacity-50">
                    {new Date(e.time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {e.exp !== 0 && ` · exp ${e.exp >= 0 ? '+' : ''}${e.exp}`}
                  </p>
                </div>
              </div>
            )
          })}
          {entries.length > 50 && (
            <div className="px-5 py-3 text-center">
              <button
                type="button"
                className="text-sm text-pen underline underline-offset-4 cursor-pointer"
                onClick={(ev) => {
                  ev.stopPropagation()
                  setShowAll(true)
                }}
              >
                查看全部 {entries.length} 条
              </button>
            </div>
          )}
        </Card>
      )}
    </section>
  )
}
