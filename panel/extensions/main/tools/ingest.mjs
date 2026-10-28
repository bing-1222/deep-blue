// ============================================================================
//  wx_ingest — 数据接入与体检
// ============================================================================
import {
  resolveDataRoot, loadManifest, loadRules, loadStations, numOrNull,
  daysInYear, pad, padStart,
} from '../core.mjs'
import { Type, meta } from './schema.mjs'

const parameters = Type.Object({
  dataRoot: Type.Optional(Type.String({
    description: '数据集根目录（含 manifest.json 与 daily/）。留空则自动定位。',
  })),
  stationIds: Type.Optional(Type.Array(Type.String(), {
    description: '只体检指定站号。留空则全部站点。',
  })),
  includeZeroYears: Type.Optional(Type.Boolean({
    description: '是否为残缺年份单独列出。默认 true。',
  })),
}, { additionalProperties: false })

export const wxIngest = {
  name: 'wx_ingest',
  description:
    '载入极端天气数据集并做完整性体检。读取 manifest.json 与 daily/*.csv，' +
    '逐站逐年统计核心要素（日最高气温、日降水）的实有天数和缺失天数，' +
    '并列出独立时段缺口。不做任何阈值计算，只报告数据本身的状态。' +
    '这是六步工具链的第一步，后续 wx_clean / wx_thresholds / wx_detect 都以它的输出为前提。',
  parameters,
  meta: meta({ deferLoading: false }),
  async execute(args, ctx) {
    const dataRoot = resolveDataRoot(args.dataRoot)
    const manifest = await loadManifest(dataRoot)
    const rules = await loadRules(dataRoot)
    const filter = args.stationIds?.length ? args.stationIds : undefined
    const stations = await loadStations(dataRoot, manifest, filter)
    if (!stations.size) {
      return { content: [{ type: 'text', text: `未在 ${dataRoot} 找到任何站点数据。` }], isError: true }
    }
    ctx?.log?.info?.(`wx_ingest: ${stations.size} 站在 ${dataRoot}`)

    const region = manifest.regions?.[0] ?? {}
    const lines = []
    lines.push(`数据集   ${manifest.dataset ?? '(未命名)'}`)
    lines.push(`适配器   ${manifest.adapter ?? '(未声明)'}`)
    lines.push(`上游     ${manifest.upstream?.provider ?? '?'}${manifest.upstream?.login_required === false ? '（免登录）' : ''}`)
    lines.push(`区域     ${region.name ?? '?'}${region.box ? `  ${JSON.stringify(region.box)}` : ''}`)
    lines.push(`站点     ${stations.size}`)
    lines.push(`基线期   ${rules.baseline_period?.join('–')}   测试期 ${rules.test_period?.join('–')}`)
    lines.push('')

    // ── 逐站体检 ──
    lines.push(`${pad('站号', 8)}${pad('海拔', 7)}${pad('分区', 10)}${pad('跨度', 24)}${pad('实有', 7)}${pad('完整度', 9)}缺口`)
    lines.push('─'.repeat(96))
    const summary = []
    let totalGaps = 0
    for (const [sid, st] of stations) {
      const m = st.meta
      const core = st.rows.filter((r) => numOrNull(r.tmax_c) !== null && numOrNull(r.prcp_mm) !== null)
      const perYear = new Map()
      for (const r of core) {
        const y = Number(r.year)
        perYear.set(y, (perYear.get(y) ?? 0) + 1)
      }
      const y0 = Number(st.rows[0].date.slice(0, 4))
      const y1 = Number(st.rows[st.rows.length - 1].date.slice(0, 4))
      let expected = 0
      for (let y = y0; y <= y1; y++) expected += daysInYear(y)
      const pct = expected ? (100 * core.length / expected) : 0

      // 缺口：连续缺失的时段（按天）
      const gaps = []
      let runStart = null
      let prev = null
      const present = new Set(core.map((r) => r.date))
      for (const r of st.rows) {
        if (!present.has(r.date)) {
          if (runStart === null) runStart = r.date
        } else if (runStart !== null) {
          gaps.push([runStart, prev])
          runStart = null
        }
        prev = r.date
      }
      if (runStart !== null) gaps.push([runStart, prev])
      const big = gaps.filter(([a, b]) =>
        (new Date(b) - new Date(a)) / 86400000 >= 6)
      totalGaps += big.length

      lines.push(
        `${pad(sid, 8)}${pad(m?.elev_m ?? '?', 7)}${pad(m?.zone ?? '?', 10)}` +
        `${pad(`${st.rows[0].date}..${st.rows[st.rows.length - 1].date}`, 24)}` +
        `${pad(core.length, 7)}${pad(pct.toFixed(1) + '%', 9)}${big.length}`)

      // 残缺年份
      const weak = []
      for (let y = y0; y <= y1; y++) {
        const n = perYear.get(y) ?? 0
        if (n < 0.9 * daysInYear(y)) weak.push(`${y}:${n}`)
      }
      if (weak.length) lines.push(`        └ 低于 90% 的年份: ${weak.join(' ')}`)
      if (big.length && args.includeZeroYears !== false) {
        for (const [a, b] of big.slice(0, 4)) {
          const d = Math.round((new Date(b) - new Date(a)) / 86400000) + 1
          lines.push(`        └ 缺口 ${a}..${b}  (${d} 天)`)
        }
        if (big.length > 4) lines.push(`        └ ... 另有 ${big.length - 4} 段缺口`)
      }

      summary.push({
        stationId: sid, name: m?.name, elevM: m?.elev_m, zone: m?.zone,
        first: st.rows[0].date, last: st.rows[st.rows.length - 1].date,
        coreDays: core.length, completenessPct: Number(pct.toFixed(2)),
        gapSegments: big.length, weakYears: weak,
      })
    }

    lines.push('')
    lines.push(`体检结论：${stations.size} 站，共 ${totalGaps} 段 ≥6 天的缺口。`)
    lines.push('下一步：调用 wx_clean 查看缺失分布与插补标记；wx_thresholds 计算基线期阈值。')

    const structured = {
      ok: true, dataRoot,
      dataset: manifest.dataset, adapter: manifest.adapter,
      region: region.name, stations: summary,
      totalGapSegments: totalGaps,
      baseline: rules.baseline_period, test: rules.test_period,
    }
    return { content: [{ type: 'text', text: lines.join('\n') }], structured }
  },
}
