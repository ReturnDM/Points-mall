import type { CSSProperties, ReactNode } from 'react'

export const wobbly: CSSProperties = {
  borderRadius: '255px 15px 225px 15px / 15px 225px 15px 255px',
}
export const wobblyMd: CSSProperties = {
  borderRadius: '55px 15px 45px 15px / 15px 45px 15px 55px',
}

export function Card({
  children,
  className = '',
  decoration,
  postit = false,
  style,
}: {
  children: ReactNode
  className?: string
  decoration?: 'tape' | 'tack'
  postit?: boolean
  style?: CSSProperties
}) {
  return (
    <div
      style={style}
      className={`relative border-2 border-ink bg-white shadow-hard-sm wobbly-md ${postit ? 'bg-postit' : ''} ${className}`}
    >
      {decoration === 'tape' && <div className="tape" aria-hidden />}
      {decoration === 'tack' && <div className="tack" aria-hidden />}
      {children}
    </div>
  )
}

export function WobblyButton({
  children,
  onClick,
  variant = 'primary',
  className = '',
  disabled,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary'
  className?: string
  disabled?: boolean
}) {
  const base =
    'inline-flex items-center justify-center gap-2 border-[3px] border-ink px-6 h-12 wobbly font-hand text-lg shadow-hard pressable cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed'
  const color =
    variant === 'primary'
      ? 'bg-white text-ink hover:bg-accent hover:text-white'
      : 'bg-muted text-ink hover:bg-pen hover:text-white'
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${color} ${className}`}>
      {children}
    </button>
  )
}

export function StickyTag({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-block bg-postit border-2 border-ink px-3 py-0.5 text-sm wobbly-sm -rotate-2 shadow-hard-sm ${className}`}
    >
      {children}
    </span>
  )
}

export function SectionTitle({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="mb-6 flex items-end gap-4">
      <h2 className="text-3xl md:text-4xl font-bold">{children}</h2>
      {sub && <span className="text-muted-foreground/0 text-base opacity-60">{sub}</span>}
      <div className="flex-1 border-b-2 border-dashed border-ink/40 mb-2" aria-hidden />
    </div>
  )
}
