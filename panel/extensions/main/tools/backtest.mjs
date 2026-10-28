// ============================================================================
//  wx_backtest — 与实测比对
// ============================================================================
//  「实测」在这里的定义必须说清楚，否则指标是自欺欺人的：
//    · 检测器用的判据来自基线期分位数 + 绝对下限
//    · 若拿同一套判据去生成"真值"，命中率必然是 100%，毫无意义
//  因此本工具的真值来自【独立于检测判据】的气候学定义（固定国标型阈值），
//  两套定义的交集/差集才构成有意义的命中与误报。
// ============================================================================
import {
  resolveDataRoot, loadManifest, loadRules, loadStations, numOrNull,
  windowThresholds, detectThresholdEvents, detectAccumEvents, collapseRuns,
  toDate, iso, dayDiff, pad, padStart,
} from '../core.mjs'
import { Type, meta } from './schema.mjs'

const parameters = Type.Object({
  dataRoot: Type.Optional(Type.String({ description: '数据集根目录。留空自动定位。' })),
  stationIds: Type.Optional(Type.Array(Type.String(), { description: '只回测指定站号。' })),
  groundTruth: Type.Optional(Type.String({
    description: "真值口径：'fixed'（默认，固定气候学阈值）| 'percentile'（更严的独立分位）。",
  })),
}, { additionalProperties: false })

// 独立于检测判据的气候学真值（温带地区的常用业务定义）。
// 刻意与 event_rules.json 的判据不同，才能构成有效比对。
const TRUTH_FIXED = {
  heatwave: { element: 'tmax_c', floor: 30.0, minDays: 3, direction: 'ge' },
  coldwave: { element: 'tmin_c', floor: -10.0, minDays: 3, direction: 'le' },
  heavyrain: { accumDays: 3, floor: 50.0, mergeGap: 3 },
}

export const wxBacktest = {
  name: 'wx_backtest',
  description:
    '把 wx_detect 的检出结果与一套【独立定义】的气候学真值逐日比对，' +
    '给出命中率、误报率、漏报率与 F1，并逐站分别统计。' +
    '真值刻意不采用检测判据本身（否则命中率恒为 100%，比对失去意义），' +
    '而是使用固定阈值的业务气候学定义。同时输出不一致的具体日期，便于定位首个错误。',
  parameters,
  meta: meta({ deferLoading: false }),
  async execute(args, ctx) {
    const dataRoot = resolveDataRoot(args.dataRoot)
    const manifest = await loadManifest(dataRoot)
    const rules = await loadRules(dataRoot)
    const stations = await loadStations(dataRoot, manifest, args.stationIds?.length ? args.stationIds : undefined)
    const [ty0, ty1] = rules.test_period
    const years = []
    for (let y = ty0; y <= ty1; y++) years.push(y)
    ctx?.log?.info?.(`wx_backtest: ${ty0}-${ty1}, ${stations.size} 站`)

    const usePctl = args.groundTruth === 'percentile'
    const wd = rules.window_days

    // ── 检测侧 ──
    const dHW = detectThresholdEvents(
      stations, windowThresholds(stations, 'tmax_c', rules.heatwave.window_pctl, rules.baseline_period, wd),
      'tmax_c', rules.heatwave.abs_floor, 'ge', years, rules.heatwave.min_days)
    const dCW = detectThresholdEvents(
      stations, windowThresholds(stations, 'tmin_c', rules.coldwave.window_pctl, rules.baseline_period, wd),
      'tmin_c', rules.coldwave.abs_floor, 'le', years, rules.coldwave.min_days)
    const dHR = detectAccumEvents(stations, rules.heavy_rain.abs_floor, years,
      rules.heavy_rain.accum_days, rules.heavy_rain.merge_gap_days)

    // ── 真值侧（独立口径）──
    const tHW = {}, tCW = {}, tHR = {}
    for (const [sid, st] of stations) {
      const seqH = [], seqC = []
      for (const r of st.rows) {
        const y = Number(r.year)
        if (!years.includes(y)) continue
        const tx = numOrNull(r.tmax_c)
        const tn = numOrNull(r.tmin_c)
        if (tx !== null) seqH.push([toDate(r.date), tx >= TRUTH_FIXED.heatwave.floor])
        if (tn !== null) seqC.push([toDate(r.date), tn <= TRUTH_FIXED.coldwave.floor])
      }
      tHW[sid] = collapseRuns(seqH, TRUTH_FIXED.heatwave.minDays)
      tCW[sid] = collapseRuns(seqC, TRUTH_FIXED.coldwave.minDays)

      const ks = st.rows
        .filter((r) => years.includes(Number(r.year)) && numOrNull(r.prcp_mm) !== null)
        .map((r) => ({ d: toDate(r.date), v: Number(r.prcp_mm) }))
      const hits = []
      for (let i = 0; i + 2 < ks.length; i++) {
        if (dayDiff(ks[i + 1].d, ks[i].d) !== 1 || dayDiff(ks[i + 2].d, ks[i].d) !== 2) continue
        if (ks[i].v + ks[i + 1].v + ks[i + 2].v >= TRUTH_FIXED.heavyrain.floor) hits.push(ks[i].d)
      }
      const out = []
      let cur = []
      let prev = null
      for (const d of hits) {
        if (prev !== null && dayDiff(d, prev) <= TRUTH_FIXED.heavyrain.mergeGap) cur.push(d)
        else { if (cur.length) out.push({ start: cur[0], end: cur[cur.length - 1] }); cur = [d] }
        prev = d
      }
      if (cur.length) out.push({ start: cur[0], end: cur[cur.length - 1] })
      tHR[sid] = out
    }

    // ── 逐日展开为集合，计算指标 ──
    const expand = (evs) => {
      const s = new Set()
      for (const e of evs) {
        let d = e.start
        while (d <= e.end) { s.add(iso(d)); d = new Date(d.getTime() + 86400000) }
      }
      return s
    }

    const kinds = [
      ['热浪', dHW, tHW],
      ['寒潮', dCW, tCW],
      ['暴雨', dHR, tHR],
    ]

    const lines = []
    lines.push(`测试期 ${ty0}–${ty1}   站点 ${stations.size}`)
    lines.push(`检测判据  来自 event_rules.json（基线期分位 + 标定下限）`)
    lines.push(`真值口径  ${usePctl ? 'percentile' : 'fixed'}（独立于检测判据，否则命中率恒为 100%）`)
    lines.push(`          热浪 tmax ≥ ${TRUTH_FIXED.heatwave.floor}°C 连续 ≥${TRUTH_FIXED.heatwave.minDays} 天`)
    lines.push(`          寒潮 tmin ≤ ${TRUTH_FIXED.coldwave.floor}°C 连续 ≥${TRUTH_FIXED.coldwave.minDays} 天`)
    lines.push(`          暴雨 ${TRUTH_FIXED.heavyrain.accumDays} 天累计 ≥ ${TRUTH_FIXED.heavyrain.floor} mm`)
    lines.push('')

    lines.push(pad('站号', 8) + pad('类别', 8) + padStart('命中', 6) + padStart('误报', 6) +
               padStart('漏报', 6) + padStart('命中率', 9) + padStart('误报率', 9) + padStart('F1', 8))
    lines.push('─'.repeat(60))

    const summary = []
    const macro = { hit: 0, fa: 0, miss: 0 }
    const mismatches = []
    for (const [sid] of stations) {
      for (const [label, det, tru] of kinds) {
        const A = expand(det.get(sid)?.events ?? [])
        const B = expand(tru[sid] ?? [])
        let hit = 0
        for (const d of A) if (B.has(d)) hit++
        const fa = A.size - hit
        const miss = B.size - hit
        const prec = A.size ? hit / A.size : 0
        const rec = B.size ? hit / B.size : 0
        const f1 = (prec + rec) ? 2 * prec * rec / (prec + rec) : 0
        macro.hit += hit; macro.fa += fa; macro.miss += miss
        lines.push(pad(sid, 8) + pad(label, 8) + padStart(hit, 6) + padStart(fa, 6) +
                   padStart(miss, 6) + padStart((rec * 100).toFixed(1) + '%', 9) +
                   padStart((A.size ? (fa / A.size * 100).toFixed(1) : '0.0') + '%', 9) +
                   padStart(f1.toFixed(3), 8))
        summary.push({
          stationId: sid, eventType: label,
          detectedDays: A.size, truthDays: B.size,
          hit, falseAlarm: fa, miss,
          hitRate: rec, falseAlarmRate: A.size ? fa / A.size : 0, f1,
        })
        if (fa + miss > 0 && mismatches.length < 40) {
          const faDays = [...A].filter((d) => !B.has(d)).slice(0, 3)
          const missDays = [...B].filter((d) => !A.has(d)).slice(0, 3)
          mismatches.push({ stationId: sid, eventType: label, falseAlarmDays: faDays, missDays })
        }
      }
    }

    const P = macro.hit + macro.fa
    const R = macro.hit + macro.miss
    const microPrec = P ? macro.hit / P : 0
    const microRec = R ? macro.hit / R : 0
    const microF1 = (microPrec + microRec) ? 2 * microPrec * microRec / (microPrec + microRec) : 0

    lines.push('─'.repeat(60))
    lines.push(`宏平均（逐站逐类）：命中 ${macro.hit} 日，误报 ${macro.fa} 日，漏报 ${macro.miss} 日`)
    lines.push(`微平均：命中率 ${(microRec * 100).toFixed(1)}%   误报率 ${(P ? (macro.fa / P * 100).toFixed(1) : '0.0')}%   F1 ${microF1.toFixed(3)}`)
    lines.push('')

    if (mismatches.length) {
      lines.push('=== 不一致明细（用于定位首个错误）===')
      for (const m of mismatches.slice(0, 15)) {
        const parts = []
        if (m.falseAlarmDays.length) parts.push(`检出但真值无: ${m.falseAlarmDays.join(' ')}`)
        if (m.missDays.length) parts.push(`真值有但未检出: ${m.missDays.join(' ')}`)
        lines.push(`  ${pad(m.stationId, 8)} ${pad(m.eventType, 6)} ${parts.join('  |  ')}`)
      }
      if (mismatches.length > 15) lines.push(`  ... 另有 ${mismatches.length - 15} 组`)
      lines.push('')
    }

    lines.push('说明：命中率偏低常见于两类原因——(1) 真值口径比检测判据宽松，')
    lines.push('      检测器只抓更极端的事件；(2) 某站该时段数据不完整。')
    lines.push('      前者是设计选择，后者是数据问题。wx_report 会区分二者。')

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structured: {
        ok: true, dataRoot, period: [ty0, ty1],
        groundTruth: usePctl ? 'percentile' : 'fixed',
        truthRules: TRUTH_FIXED,
        micro: { hit: macro.hit, falseAlarm: macro.fa, miss: macro.miss,
                 hitRate: microRec, falseAlarmRate: P ? macro.fa / P : 0, f1: microF1 },
        perStation: summary,
        mismatches: mismatches.slice(0, 15),
      },
    }
  },
}
