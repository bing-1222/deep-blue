// ============================================================================
//  wx_detect — 执行检测
// ============================================================================
import {
  resolveDataRoot, loadManifest, loadRules, loadStations,
  windowThresholds, detectThresholdEvents, detectAccumEvents, fmtEvent, iso, pad,
} from '../core.mjs'
import { Type, meta } from './schema.mjs'

const parameters = Type.Object({
  dataRoot: Type.Optional(Type.String({ description: '数据集根目录。留空自动定位。' })),
  stationIds: Type.Optional(Type.Array(Type.String(), { description: '只检测指定站号。' })),
  period: Type.Optional(Type.String({
    description: "检测区间：'test'（默认，用 event_rules.json 的测试期）、'all'（2000-2025），或 'YYYY-YYYY'。",
  })),
  eventTypes: Type.Optional(Type.Array(Type.String({
    description: "事件类型：'heatwave' | 'coldwave' | 'heavyrain'。留空则全部。",
  }))),
  listEvents: Type.Optional(Type.Boolean({ description: '是否逐条列出事件。默认 true。' })),
}, { additionalProperties: false })

/** 解析 period 参数 -> [y0, y1] */
function parsePeriod(spec, rules) {
  if (!spec || spec === 'test') return rules.test_period
  if (spec === 'all') return [2000, 2025]
  const m = /^(\d{4})-(\d{4})$/.exec(spec)
  if (!m) throw new Error(`period 格式无效: ${spec}（应为 test | all | YYYY-YYYY）`)
  return [Number(m[1]), Number(m[2])]
}

export const wxDetect = {
  name: 'wx_detect',
  description:
    '用 wx_thresholds 的基线期阈值在指定区间检出极端天气事件。' +
    '支持三类事件：热浪（tmax 超窗口分位且超绝对下限，连续多日）、' +
    '寒潮（tmin 低于窗口分位且低于绝对下限，连续多日）、' +
    '暴雨（多日累计降水超下限）。输出每个站的事件清单（起止日期与持续天数）。' +
    '判据全部来自 event_rules.json，工具内不硬编码任何气候常数。',
  parameters,
  meta: meta({ deferLoading: false }),
  async execute(args, ctx) {
    const dataRoot = resolveDataRoot(args.dataRoot)
    const manifest = await loadManifest(dataRoot)
    const rules = await loadRules(dataRoot)
    const stations = await loadStations(dataRoot, manifest, args.stationIds?.length ? args.stationIds : undefined)

    const [y0, y1] = parsePeriod(args.period, rules)
    const years = []
    for (let y = y0; y <= y1; y++) years.push(y)
    const want = args.eventTypes?.length
      ? args.eventTypes
      : ['heatwave', 'coldwave', 'heavyrain']
    const listEvents = args.listEvents !== false
    ctx?.log?.info?.(`wx_detect: ${y0}-${y1}, ${stations.size} 站`)

    const wd = rules.window_days
    const res = {}

    if (want.includes('heatwave')) {
      const thr = windowThresholds(stations, 'tmax_c', rules.heatwave.window_pctl, rules.baseline_period, wd)
      res.heatwave = detectThresholdEvents(stations, thr, 'tmax_c',
        rules.heatwave.abs_floor, 'ge', years, rules.heatwave.min_days)
    }
    if (want.includes('coldwave')) {
      const thr = windowThresholds(stations, 'tmin_c', rules.coldwave.window_pctl, rules.baseline_period, wd)
      res.coldwave = detectThresholdEvents(stations, thr, 'tmin_c',
        rules.coldwave.abs_floor, 'le', years, rules.coldwave.min_days)
    }
    if (want.includes('heavyrain')) {
      res.heavyrain = detectAccumEvents(stations,
        rules.heavy_rain.abs_floor, years,
        rules.heavy_rain.accum_days, rules.heavy_rain.merge_gap_days)
    }

    const LABEL = { heatwave: '热浪', coldwave: '寒潮', heavyrain: '暴雨' }
    const lines = []
    lines.push(`检测区间 ${y0}–${y1}   阈值来自基线期 ${rules.baseline_period.join('–')}`)
    lines.push(`判据  热浪 tmax ≥ P${(rules.heatwave.window_pctl * 100).toFixed(0)} 且 ≥ ${rules.heatwave.abs_floor}°C，连续 ≥${rules.heatwave.min_days} 天`)
    lines.push(`      寒潮 tmin ≤ P${(rules.coldwave.window_pctl * 100).toFixed(0)} 且 ≤ ${rules.coldwave.abs_floor}°C，连续 ≥${rules.coldwave.min_days} 天`)
    lines.push(`      暴雨 ${rules.heavy_rain.accum_days} 天累计 ≥ ${rules.heavy_rain.abs_floor} mm`)
    lines.push('')

    // 汇总表
    const kinds = want.filter((k) => res[k])
    lines.push(pad('站号', 8) + pad('海拔', 7) + kinds.map((k) => pad(LABEL[k], 8)).join(''))
    lines.push('─'.repeat(8 + 7 + 8 * kinds.length))
    const totals = {}
    const structuredStations = []
    for (const [sid, st] of stations) {
      const cells = kinds.map((k) => {
        const n = res[k].get(sid)?.events.length ?? 0
        totals[k] = (totals[k] ?? 0) + n
        return pad(n, 8)
      })
      lines.push(pad(sid, 8) + pad(st.meta?.elev_m ?? '?', 7) + cells.join(''))
      structuredStations.push({
        stationId: sid, name: st.meta?.name, elevM: st.meta?.elev_m,
        counts: Object.fromEntries(kinds.map((k) => [k, res[k].get(sid)?.events.length ?? 0])),
      })
    }
    lines.push('─'.repeat(8 + 7 + 8 * kinds.length))
    lines.push(pad('合计', 8) + pad('', 7) + kinds.map((k) => pad(totals[k] ?? 0, 8)).join(''))
    lines.push('')

    // 逐条列出
    const eventsOut = {}
    if (listEvents) {
      for (const k of kinds) {
        lines.push(`=== ${LABEL[k]} 事件清单 ===`)
        eventsOut[k] = {}
        for (const [sid] of stations) {
          const evs = res[k].get(sid)?.events ?? []
          eventsOut[k][sid] = evs.map((e) => ({
            start: iso(e.start), end: iso(e.end),
            days: e.days ?? e.hits, label: fmtEvent(e),
          }))
          if (!evs.length) {
            lines.push(`  ${pad(sid, 8)} (无)`)
          } else {
            lines.push(`  ${pad(sid, 8)} ${evs.length} 段`)
            for (const e of evs) {
              const dur = e.days ?? e.hits
              lines.push(`            ${pad(fmtEvent(e), 26)} ${pad(dur, 3)} ${e.days ? '天' : '个命中日'}`)
            }
          }
        }
        lines.push('')
      }
    }

    lines.push('下一步：调用 wx_backtest 与气候学期望比对，得到命中率/误报率/漏报率。')

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structured: {
        ok: true, dataRoot, period: [y0, y1], eventTypes: kinds,
        totals, stations: structuredStations,
        events: listEvents ? eventsOut : undefined,
      },
    }
  },
}
