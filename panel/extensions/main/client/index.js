// ============================================================================
//  WeatherLab · 极端天气监测面板
//  AGH 前端插件（浏览器直接加载，零构建步骤）
// ============================================================================
//
//  ── 本版的核心约束：绝不拖累宿主 UI ──────────────────────────────────────
//
//  上一版用了 useSyncExternalStore 订阅 AGH 的 SessionService，结果出现
//  「侧边栏无法折叠、无法新建对话」——宿主 UI 被锁死。
//
//  前端模块是**插进宿主 React 树里**的，一旦它抛异常或进入渲染循环，
//  坏掉的不只是面板，而是整个侧边栏。所以本版改为三条硬规则：
//
//    1. **不订阅任何宿主状态**。会话 id 每次渲染直接读一次，配合定时器刷新。
//       （useSyncExternalStore 要求宿主 subscribe 在并发渲染下严格稳定，
//         AGH 的实现未必满足；不值得为省一次轮询冒锁死宿主的风险）
//    2. **全组件包一层 ErrorBoundary**。任何渲染异常都挡在面板内部，
//       宿主侧边栏不受影响——宁可面板显示"不可用"，也不能让用户不能新建对话。
//    3. **不裸访问宿主能力**。所有 ctx.* 访问都走 try/catch。
//
//  ── 数据来源 ──────────────────────────────────────────────────────────────
//  面板不写死任何数字。指标通过同包服务实时获取：
//      await ctx.agnes.services.call('weatherlab.panel.metrics', {})
//  服务名必须同时列在 agnes.client.json 的 client.services 数组里。
//
//  ── 宿主约束 ──────────────────────────────────────────────────────────────
//  AGH 允许插件注册的槽位是白名单制（packages/protocol/src/package-admin.ts
//  的 WEB_HOST_REGION_SLOT_NAMES），适合常驻信息面板的只有 'ui:sidebar'。
//  故按**窄栏**设计：单列、紧凑。
//
//  import map 可用模块：react / react-jsx-runtime / react-dom /
//  react-dom-client / antd / assistant-ui / cordis / web-client
//  这里只用 react。
// ============================================================================

import {
  Component, createElement, useCallback, useEffect, useMemo, useRef, useState,
} from 'react'

const SERVICE = 'weatherlab.panel.metrics'
const DEFAULT_REFRESH_MS = 60000

const EVENT = {
  heatwave: { name: '高温', tone: 'hot' },
  coldwave: { name: '低温', tone: 'cold' },
  heavyrain: { name: '强降水', tone: 'wet' },
}
const EVENT_ORDER = ['heatwave', 'coldwave', 'heavyrain']

// ── 通用 ─────────────────────────────────────────────────────────────────
const h = (type, props, ...kids) => createElement(type, props, ...kids)
const asPct = (x) => (x === null || x === undefined ? null : (x * 100).toFixed(0))
const yearOf = (s) => (typeof s === 'string' ? s.slice(0, 4) : null)

const shortRange = (a, b) => {
  if (!a) return '—'
  if (!b || a === b) return a
  return yearOf(a) === yearOf(b) ? `${a} → ${b.slice(5)}` : `${a} → ${b}`
}

const stationShort = (name) => {
  if (!name) return ''
  const first = String(name).trim().split(/\s{2,}/)[0]
  return first.length > 14 ? first.slice(0, 13) + '…' : first
}

// ── ErrorBoundary：把面板的异常挡在面板内部 ──────────────────────────────
//
//  这是本版最重要的一段。宿主把我们的组件插进它自己的 React 树，
//  我们抛异常 = 宿主那棵子树一起挂掉。有了它，最坏情况只是面板显示一行提示。

class PanelBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    try {
      console.warn('[WeatherLab] 面板渲染异常（已隔离，宿主不受影响）', error, info)
    } catch { /* 忽略 */ }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return h('div', { className: 'wxpanel', 'data-slot': 'ui:sidebar' },
      h('div', { className: 'wxpanel-head' },
        h('span', { className: 'wxpanel-title' }, '极端天气监测')),
      h('div', { className: 'wxpanel-body' },
        h('div', { className: 'wxstatus', 'data-tone': 'err' },
          h('i', { className: 'wxstatus-dot' }),
          h('span', { className: 'wxstatus-txt' }, '面板渲染异常，已隔离')),
        h('div', { className: 'wxempty' }, String(error?.message ?? error).slice(0, 200))),
    )
  }
}

// ── 安全读取宿主上下文（任何异常都不外泄）────────────────────────────────

/** 读会话 id：拿不到就返回 undefined，绝不抛错 */
function readSessionId(session) {
  try {
    const id = session?.sessionId
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return undefined
  }
}

/** 取服务调用器：拿不到返回 null */
function readCaller(ctx) {
  try {
    const c = ctx?.agnes?.services
    return c && typeof c.call === 'function' ? c : null
  } catch {
    return null
  }
}

// ── 取数 ─────────────────────────────────────────────────────────────────
//
//  waiting —— 没有活动会话（正常状态，等用户开会话）
//  loading —— 有会话，正在取
//  error   —— 真出错
function useMetrics(ctx, sessionId, intervalMs) {
  const [state, setState] = useState({ phase: 'waiting' })
  const alive = useRef(true)
  const seq = useRef(0)

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async (silent) => {
    if (!sessionId) {
      if (alive.current) setState({ phase: 'waiting' })
      return
    }
    const caller = readCaller(ctx)
    if (!caller) {
      if (alive.current) setState({ phase: 'error', reason: '数据服务未在客户端声明' })
      return
    }
    const mine = ++seq.current
    setState((prev) =>
      silent && prev.phase === 'ok' ? { ...prev, busy: true } : { phase: 'loading' })
    try {
      const data = await caller.call(SERVICE, { sessionId })
      if (!alive.current || mine !== seq.current) return
      if (!data || data.ok !== true) {
        setState({ phase: 'error', reason: data?.error ?? '服务返回异常' })
        return
      }
      setState({ phase: 'ok', data, revisedAt: Date.now() })
    } catch (error) {
      if (!alive.current || mine !== seq.current) return
      try {
        console.warn('[WeatherLab] 指标获取失败', { service: SERVICE, error })
      } catch { /* 忽略 */ }
      const msg = String(error?.message ?? error)
      // 会话失效：退回等待态，不当故障
      if (/active session/i.test(msg)) { setState({ phase: 'waiting' }); return }
      setState({ phase: 'error', reason: msg.slice(0, 140) })
    }
  }, [ctx, sessionId])

  useEffect(() => { void load(false) }, [load])
  useEffect(() => {
    if (!intervalMs || !sessionId) return undefined
    const t = window.setInterval(() => { void load(true) }, intervalMs)
    return () => window.clearInterval(t)
  }, [load, intervalMs, sessionId])

  return { state, refresh: () => void load(true) }
}

// ── 年际分布图 ────────────────────────────────────────────────────────────
function YearStrip({ series, busiest }) {
  const [hover, setHover] = useState(null)
  const max = useMemo(
    () => Math.max(1, ...(series ?? []).map((s) => Number(s.total) || 0)),
    [series])

  if (!Array.isArray(series) || series.length === 0) return null
  const first = series[0]?.year
  const last = series[series.length - 1]?.year

  return h('div', { className: 'wxstrip' },
    h('div', { className: 'wxstrip-head' },
      h('span', null, '逐年识别次数'),
      h('span', { className: 'wxstrip-peak' },
        busiest ? `最多 ${busiest.year} 年 · ${busiest.total} 次` : '')),

    h('div', { className: 'wxstrip-bars', onMouseLeave: () => setHover(null) },
      series.map((s) => {
        const total = Number(s.total) || 0
        const segs = EVENT_ORDER.map((k) => ({ k, n: Number(s[k]) || 0 })).filter((x) => x.n > 0)
        return h('div', {
          key: String(s.year),
          className: 'wxstrip-col',
          'data-hover': hover === s.year ? 'true' : 'false',
          style: { height: `${Math.max(total ? 8 : 2, (total / max) * 100)}%` },
          onMouseEnter: () => setHover(s.year),
          title: `${s.year} 年：共 ${total} 次`,
        },
          total === 0
            ? h('i', { className: 'wxstrip-zero', 'aria-hidden': 'true' })
            : segs.map(({ k, n }) => h('i', {
                key: k,
                className: 'wxstrip-seg',
                'data-tone': EVENT[k]?.tone,
                style: { flexGrow: n },
              })),
        )
      })),

    h('div', { className: 'wxstrip-axis' },
      h('span', null, first),
      h('span', { className: 'wxstrip-legend' }, EVENT_ORDER.map((k) =>
        h('i', { key: k, className: 'wxstrip-dot', 'data-tone': EVENT[k]?.tone }, EVENT[k]?.name))),
      h('span', null, last)),

    hover !== null
      ? h('div', { className: 'wxstrip-read' }, (() => {
          const s = series.find((x) => x.year === hover)
          if (!s) return null
          const parts = EVENT_ORDER.filter((k) => Number(s[k]) > 0).map((k) => `${EVENT[k]?.name} ${s[k]}`)
          return `${s.year} 年　共 ${s.total} 次${parts.length ? '（' + parts.join('，') + '）' : ''}`
        })())
      : null,
  )
}

// ── 小组件 ────────────────────────────────────────────────────────────────
function Card({ title, hint, children }) {
  return h('section', { className: 'wxcard' },
    h('header', { className: 'wxcard-head' },
      h('h4', null, title),
      hint ? h('span', { className: 'wxcard-hint' }, hint) : null),
    h('div', { className: 'wxcard-body' }, children))
}

function Figure({ label, value, unit, note, weak }) {
  return h('div', { className: 'wxfig', 'data-weak': weak ? 'true' : 'false' },
    h('div', { className: 'wxfig-v' },
      value === null || value === undefined ? '—' : String(value),
      unit ? h('i', null, unit) : null),
    h('div', { className: 'wxfig-l' }, label),
    note ? h('div', { className: 'wxfig-n' }, note) : null)
}

function Line({ k, v }) {
  return h('div', { className: 'wxline' },
    h('span', { className: 'wxline-k' }, k),
    h('span', { className: 'wxline-v' }, v == null || v === '' ? '—' : v))
}

// ── 主面板 ────────────────────────────────────────────────────────────────
function Dashboard({ ctx, config }) {
  const pub = config?.publicConfig ?? {}
  const [open, setOpen] = useState(!pub.collapsed)

  // 直接读，不订阅。宿主把 sessionId 挂在 ctx.session 上。
  let session = null
  try { session = ctx?.session ?? null } catch { session = null }
  const sessionId = readSessionId(session)

  const { state, refresh } = useMetrics(ctx, sessionId, pub.refreshMs ?? DEFAULT_REFRESH_MS)
  const toggle = useCallback(() => setOpen((v) => !v), [])

  const d = state.data
  const busy = state.phase === 'loading' || state.busy === true

  const status = useMemo(() => {
    switch (state.phase) {
      case 'ok':
        return { tone: 'ok', text: busy ? '正在同步…' : '数据已同步', canSync: true }
      case 'loading':
        return { tone: 'wait', text: '读取数据…', canSync: false }
      case 'waiting':
        return { tone: 'wait', text: '先打开一个会话，面板随后自动加载', canSync: false }
      case 'error':
        return { tone: 'err', text: `数据不可用：${state.reason}`, canSync: true }
      default:
        return { tone: 'wait', text: String(state.phase), canSync: false }
    }
  }, [state, busy])

  const totalEvents = d
    ? EVENT_ORDER.reduce((a, k) => a + (Number(d.detected?.[k]) || 0), 0)
    : null

  const regionName = d?.region?.name?.includes('Harz')
    ? '德国 · 哈茨山及前麓'
    : (d?.region?.name ?? null)

  return h('div', { className: 'wxpanel', 'data-slot': 'ui:sidebar' },

    h('button', {
      type: 'button', className: 'wxpanel-head', onClick: toggle,
      'aria-expanded': open ? 'true' : 'false',
      title: open ? '收起面板' : '展开面板',
    },
      h('span', { className: 'wxpanel-caret' }, open ? '▾' : '▸'),
      h('span', { className: 'wxpanel-title' }, pub.label ?? '极端天气监测'),
      pub.badge ? h('span', { className: 'wxpanel-badge' }, pub.badge) : null),

    !open ? null : h('div', { className: 'wxpanel-body' },

      h('div', { className: 'wxstatus', 'data-tone': status.tone },
        h('i', { className: 'wxstatus-dot' }),
        h('span', { className: 'wxstatus-txt' }, status.text),
        status.canSync
          ? h('button', {
              type: 'button', className: 'wxstatus-btn',
              onClick: refresh, disabled: busy, title: '重新同步',
            }, busy ? '···' : '同步')
          : null),

      !d && state.phase === 'waiting'
        ? h('div', { className: 'wxempty' },
            h('p', null, '监测数据在会话打开后自动读取。'),
            h('p', { className: 'wxempty-sub' }, '在左侧发起一次对话即可。'))
        : null,
      !d && state.phase === 'loading'
        ? h('div', { className: 'wxempty' }, '读取监测数据…')
        : null,

      !d ? null : h('div', { className: 'wxstack' },

        h(Card, {
          title: '监测范围',
          hint: d.region?.stationCount ? `${d.region.stationCount} 站` : null,
        },
          h(Line, { k: '区域', v: regionName }),
          h(Line, { k: '海拔', v: d.region?.elevMin != null ? `${d.region.elevMin} – ${d.region.elevMax} m` : null }),
          h(Line, { k: '年限', v: d.dataset?.first ? `${yearOf(d.dataset.first)} – ${yearOf(d.dataset.last)}` : null })),

        h(Card, { title: '数据质量' },
          h('div', { className: 'wxfigs' },
            h(Figure, {
              label: '基线期', unit: '%', value: d.dataset?.minBaselinePct,
              note: (d.periods?.baseline ?? []).join('–'),
              weak: d.dataset?.minBaselinePct != null && d.dataset.minBaselinePct < 95,
            }),
            h(Figure, {
              label: '评估期', unit: '%', value: d.dataset?.minTestPct,
              note: (d.periods?.test ?? []).join('–'),
              weak: d.dataset?.minTestPct != null && d.dataset.minTestPct < 95,
            })),
          h('p', { className: 'wxfoot' },
            `识别基准取自 ${(d.periods?.baseline ?? []).join('–')} 年，评估期为 ${(d.periods?.test ?? []).join('–')} 年`)),

        h(Card, {
          title: '识别结果',
          hint: totalEvents != null ? `共 ${totalEvents} 次` : null,
        },
          h('div', { className: 'wxfigs' }, EVENT_ORDER.map((k) =>
            h(Figure, { key: k, label: EVENT[k]?.name, unit: '次', value: d.detected?.[k] ?? null }))),
          h(YearStrip, { series: d.yearSeries ?? [], busiest: d.busiestYear })),

        h(Card, {
          title: '准确性',
          hint: d.metrics?.hit != null ? `命中 ${d.metrics.hit} 天` : null,
        },
          h('div', { className: 'wxfigs' },
            h(Figure, { label: '命中率', unit: '%', value: asPct(d.metrics?.hitRate) }),
            h(Figure, { label: '误报率', unit: '%', value: asPct(d.metrics?.falseAlarmRate) }),
            h(Figure, { label: '漏报率', unit: '%', value: asPct(d.metrics?.missRate) })),
          h('p', { className: 'wxfoot' }, '与独立整理的历史记录逐日比对得出')),

        h(Card, { title: '判定依据', hint: '已冻结' },
          h('dl', { className: 'wxrules' }, EVENT_ORDER.flatMap((k) => {
            const t = d.thresholds?.[k]
            if (!t) return []
            const cond = k === 'heavyrain'
              ? `三日累计降水 ≥ ${t.floor} mm`
              : k === 'heatwave'
                ? `日最高气温 ≥ ${t.floor} °C，且高于同期常态`
                : `日最低气温 ≤ ${t.floor} °C，且低于同期常态`
            const dur = k === 'heavyrain' ? '同一过程合并为一次' : `持续 ${t.minDays} 天以上`
            return [
              h('dt', { key: k + 't' }, EVENT[k]?.name),
              h('dd', { key: k + 'd' }, cond, h('em', null, dur)),
            ]
          }))),

        Array.isArray(d.validation) && d.validation.length
          ? h(Card, { title: '历史回验', hint: `${d.validation.length} 例` },
              h('ul', { className: 'wxverify' }, d.validation.map((v) =>
                h('li', { key: String(v.label), 'data-ok': String(v.ok) },
                  h('span', { className: 'wxverify-l' }, v.label),
                  h('b', null, `${v.hit}/${v.total}`)))))
          : null,

        Array.isArray(d.recent) && d.recent.length
          ? h(Card, { title: '最近识别' },
              h('ul', { className: 'wxrecent' }, d.recent.slice(0, 6).map((e, i) =>
                h('li', { key: String(i), 'data-tone': EVENT[e.kind]?.tone },
                  h('i', { className: 'wxrecent-k' }, EVENT[e.kind]?.name ?? e.kind),
                  h('span', { className: 'wxrecent-d' }, shortRange(e.start, e.end)),
                  h('span', { className: 'wxrecent-s', title: e.stationName }, stationShort(e.stationName))))))
          : null,

        h('div', { className: 'wxpanel-foot' },
          state.revisedAt ? `更新于 ${new Date(state.revisedAt).toLocaleTimeString()}` : ''),
      ),
    ),
  )
}

// ── 注册进槽位 ────────────────────────────────────────────────────────────
// 槽位名需同时出现两处：
//   ① 本文件 ctx.slots.register('ui:sidebar', ...)
//   ② agnes.client.json 的 client.slots

export function apply(ctx, config) {
  const render = (props) => h(PanelBoundary, null, h(Dashboard, { ctx, config, ...props }))
  ctx.slots.register('ui:sidebar', render, { priority: -100 })
}
