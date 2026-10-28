// ============================================================================
//  wx_report — 报告与首错定位
// ============================================================================
import {
  resolveDataRoot, loadManifest, loadRules, loadStations, numOrNull, daysInYear,
  windowThresholds, detectThresholdEvents, detectAccumEvents, collapseRuns,
  toDate, iso, dayDiff, pad, padStart, fmtEvent,
} from '../core.mjs'
import { Type, meta } from './schema.mjs'

const parameters = Type.Object({
  dataRoot: Type.Optional(Type.String({ description: '数据集根目录。留空自动定位。' })),
  stationIds: Type.Optional(Type.Array(Type.String(), { description: '只报告指定站号。' })),
  maxFirstErrors: Type.Optional(Type.Integer({
    description: '最多列出多少个「第一个错误」。默认 5。', minimum: 1, maximum: 50,
  })),
}, { additionalProperties: false })

const TRUTH = {
  heatwave: { element: 'tmax_c', floor: 30.0, minDays: 3, dir: 'ge', label: '热浪' },
  coldwave: { element: 'tmin_c', floor: -10.0, minDays: 3, dir: 'le', label: '寒潮' },
  heavyrain: { accumDays: 3, floor: 50.0, mergeGap: 3, label: '暴雨' },
}

export const wxReport = {
  name: 'wx_report',
  description:
    '汇总整条工具链的结果并生成可读报告：数据集概况、事件统计、验证指标、' +
    '以及最重要的【第一个错在哪】——按时间顺序定位每站每类的首个不一致日期，' +
    '并判断该错误属于判据设计差异还是数据缺失。' +
    '报告同时披露数据完整性对结论的限制，便于答辩时如实说明。',
  parameters,
  meta: meta({ deferLoading: false }),
  async execute(args, ctx) {
    const dataRoot = resolveDataRoot(args.dataRoot)
    const manifest = await loadManifest(dataRoot)
    const rules = await loadRules(dataRoot)
    const stations = await loadStations(dataRoot, manifest, args.stationIds?.length ? args.stationIds : undefined)
    const maxFE = args.maxFirstErrors ?? 5
    const [ty0, ty1] = rules.test_period
    const years = []
    for (let y = ty0; y <= ty1; y++) years.push(y)
    ctx?.log?.info?.('wx_report: 汇总中')

    const wd = rules.window_days
    const region = manifest.regions?.[0] ?? {}

    // ── 检测侧 ──
    const dHW = detectThresholdEvents(
      stations, windowThresholds(stations, 'tmax_c', rules.heatwave.window_pctl, rules.baseline_period, wd),
      'tmax_c', rules.heatwave.abs_floor, 'ge', years, rules.heatwave.min_days)
    const dCW = detectThresholdEvents(
      stations, windowThresholds(stations, 'tmin_c', rules.coldwave.window_pctl, rules.baseline_period, wd),
      'tmin_c', rules.coldwave.abs_floor, 'le', years, rules.coldwave.min_days)
    const dHR = detectAccumEvents(stations, rules.heavy_rain.abs_floor, years,
      rules.heavy_rain.accum_days, rules.heavy_rain.merge_gap_days)

    // ── 真值侧 ──
    const tHW = {}, tCW = {}, tHR = {}, missingByStation = {}
    for (const [sid, st] of stations) {
      const sH = [], sC = []
      let missing = 0
      for (const r of st.rows) {
        const y = Number(r.year)
        if (!years.includes(y)) continue
        const tx = numOrNull(r.tmax_c)
        const tn = numOrNull(r.tmin_c)
        if (tx === null || numOrNull(r.prcp_mm) === null) missing++
        if (tx !== null) sH.push([toDate(r.date), tx >= TRUTH.heatwave.floor])
        if (tn !== null) sC.push([toDate(r.date), tn <= TRUTH.coldwave.floor])
      }
      missingByStation[sid] = missing
      tHW[sid] = collapseRuns(sH, TRUTH.heatwave.minDays)
      tCW[sid] = collapseRuns(sC, TRUTH.coldwave.minDays)

      const ks = st.rows
        .filter((r) => years.includes(Number(r.year)) && numOrNull(r.prcp_mm) !== null)
        .map((r) => ({ d: toDate(r.date), v: Number(r.prcp_mm) }))
      const hits = []
      for (let i = 0; i + 2 < ks.length; i++) {
        if (dayDiff(ks[i + 1].d, ks[i].d) !== 1 || dayDiff(ks[i + 2].d, ks[i].d) !== 2) continue
        if (ks[i].v + ks[i + 1].v + ks[i + 2].v >= TRUTH.heavyrain.floor) hits.push(ks[i].d)
      }
      const out = []
      let cur = []
      let prev = null
      for (const d of hits) {
        if (prev !== null && dayDiff(d, prev) <= TRUTH.heavyrain.mergeGap) cur.push(d)
        else { if (cur.length) out.push({ start: cur[0], end: cur[cur.length - 1] }); cur = [d] }
        prev = d
      }
      if (cur.length) out.push({ start: cur[0], end: cur[cur.length - 1] })
      tHR[sid] = out
    }

    const expand = (evs) => {
      const s = new Set()
      for (const e of evs) {
        let d = e.start
        while (d <= e.end) { s.add(iso(d)); d = new Date(d.getTime() + 86400000) }
      }
      return s
    }

    const KINDS = [['heatwave', TRUTH.heatwave.label, dHW, tHW],
                   ['coldwave', TRUTH.coldwave.label, dCW, tCW],
                   ['heavyrain', TRUTH.heavyrain.label, dHR, tHR]]

    const lines = []
    lines.push('╔' + '═'.repeat(70) + '╗')
    lines.push('║' + ' 极端天气检测报告'.padEnd(62) + '║')
    lines.push('╚' + '═'.repeat(70) + '╝')
    lines.push('')
    lines.push(`数据集    ${manifest.dataset ?? '?'}`)
    lines.push(`区域      ${region.name ?? '?'}${region.box ? `  ${JSON.stringify(region.box)}` : ''}`)
    lines.push(`上游      ${manifest.upstream?.provider ?? '?'}`)
    lines.push(`站点      ${stations.size}`)
    lines.push(`基线期    ${rules.baseline_period.join('–')}    测试期 ${ty0}–${ty1}`)
    lines.push('')

    // ── 数据完整性 ──
    lines.push('── 数据完整性 ──')
    let worstStation = null
    for (const [sid, st] of stations) {
      const [b0, b1] = rules.baseline_period
      const baseCore = st.rows.filter((r) => {
        const y = Number(r.year)
        return y >= b0 && y <= b1 && numOrNull(r.tmax_c) !== null && numOrNull(r.prcp_mm) !== null
      }).length
      let baseExp = 0
      for (let y = b0; y <= b1; y++) baseExp += daysInYear(y)
      const testCore = st.rows.filter((r) => {
        const y = Number(r.year)
        return y >= ty0 && y <= ty1 && numOrNull(r.tmax_c) !== null && numOrNull(r.prcp_mm) !== null
      }).length
      let testExp = 0
      for (let y = ty0; y <= ty1; y++) testExp += daysInYear(y)
      const bp = 100 * baseCore / baseExp
      const tp = 100 * testCore / testExp
      lines.push(`  ${pad(sid, 8)}${pad(st.meta?.name?.slice(0, 26) ?? '', 28)}` +
                 `基线 ${bp.toFixed(1)}%   测试 ${tp.toFixed(1)}%`)
      if (!worstStation || tp < worstStation[1]) worstStation = [sid, tp]
    }
    lines.push('')

    // ── 事件统计 ──
    lines.push('── 事件统计（检出）──')
    lines.push('  ' + pad('站号', 8) + pad('热浪', 8) + pad('寒潮', 8) + pad('暴雨', 8))
    const totals = { heatwave: 0, coldwave: 0, heavyrain: 0 }
    for (const [sid] of stations) {
      const c = {
        heatwave: dHW.get(sid)?.events.length ?? 0,
        coldwave: dCW.get(sid)?.events.length ?? 0,
        heavyrain: dHR.get(sid)?.events.length ?? 0,
      }
      for (const k of Object.keys(totals)) totals[k] += c[k]
      lines.push('  ' + pad(sid, 8) + pad(c.heatwave, 8) + pad(c.coldwave, 8) + pad(c.heavyrain, 8))
    }
    lines.push('  ' + pad('合计', 8) + pad(totals.heatwave, 8) + pad(totals.coldwave, 8) + pad(totals.heavyrain, 8))
    lines.push('')

    // ── 验证指标 ──
    lines.push('── 验证指标（真值 = 固定气候学阈值，独立于检测判据）──')
    lines.push('  ' + pad('站号', 8) + pad('类别', 7) + padStart('命中', 6) + padStart('误报', 6) +
               padStart('漏报', 6) + padStart('命中率', 9) + padStart('F1', 8))
    let mH = 0, mF = 0, mM = 0
    const perCell = []
    for (const [sid] of stations) {
      for (const [key, label, det, tru] of KINDS) {
        const A = expand(det.get(sid)?.events ?? [])
        const B = expand(tru[sid] ?? [])
        let hit = 0
        for (const d of A) if (B.has(d)) hit++
        const fa = A.size - hit
        const miss = B.size - hit
        mH += hit; mF += fa; mM += miss
        const prec = A.size ? hit / A.size : 0
        const rec = B.size ? hit / B.size : 0
        const f1 = (prec + rec) ? 2 * prec * rec / (prec + rec) : 0
        perCell.push({ sid, key, label, A, B, hit, fa, miss, rec, f1 })
        lines.push('  ' + pad(sid, 8) + pad(label, 7) + padStart(hit, 6) + padStart(fa, 6) +
                   padStart(miss, 6) + padStart((rec * 100).toFixed(1) + '%', 9) + padStart(f1.toFixed(3), 8))
      }
    }
    const P = mH + mF
    const microRec = (mH + mM) ? mH / (mH + mM) : 0
    const microF1 = P && (mH + mM) ? (2 * (mH / P) * microRec) / ((mH / P) + microRec) : 0
    lines.push('')
    lines.push(`  合计：命中 ${mH} 日  误报 ${mF} 日  漏报 ${mM} 日`)
    lines.push(`  命中率 ${(microRec * 100).toFixed(1)}%   误报率 ${P ? (mF / P * 100).toFixed(1) : '0.0'}%   F1 ${microF1.toFixed(3)}`)
    lines.push('')

    // ── 第一个错在哪 ──
    lines.push('── 第一个错在哪（按时间顺序定位首个不一致）──')
    const firstErrors = []
    for (const cell of perCell) {
      const all = [...new Set([...cell.A, ...cell.B])].sort()
      for (const d of all) {
        const inA = cell.A.has(d)
        const inB = cell.B.has(d)
        if (inA === inB) continue
        firstErrors.push({
          stationId: cell.sid, eventType: cell.label, date: d,
          kind: inA ? '误报（检出但真值无）' : '漏报（真值有但未检出）',
        })
        break
      }
    }
    firstErrors.sort((a, b) => (a.date < b.date ? -1 : 1))
    if (!firstErrors.length) {
      lines.push('  无任何不一致——检测判据与真值口径在该时段完全一致。')
    } else {
      for (const fe of firstErrors.slice(0, maxFE)) {
        // 判断是数据缺失还是判据差异
        const st = stations.get(fe.stationId)
        const row = st?.byDate.get(fe.date)
        let cause = '判据差异（两套定义宽严不同）'
        if (!row || numOrNull(row.tmax_c) === null || numOrNull(row.prcp_mm) === null) {
          cause = '**数据缺失**（该日核心要素不全，检测器无法判定）'
        }
        lines.push(`  ${pad(fe.date, 12)} ${pad(fe.stationId, 8)} ${pad(fe.eventType, 6)} ${fe.kind}`)
        lines.push(`               成因：${cause}`)
      }
      if (firstErrors.length > maxFE) lines.push(`  ... 另有 ${firstErrors.length - maxFE} 处`)
    }
    lines.push('')

    // ── 结论与限制 ──
    lines.push('── 结论与限制 ──')
    lines.push(`  1. 检测判据由基线期 ${rules.baseline_period.join('–')} 的数据标定，`)
    lines.push(`     下限为使基线期产出约 0.3–1.5 次/站/年而定，非通用气候常数。`)
    lines.push(`  2. 真值采用固定阈值口径（热浪 ≥${TRUTH.heatwave.floor}°C / 寒潮 ≤${TRUTH.coldwave.floor}°C / ` +
               `暴雨 ${TRUTH.heavyrain.accumDays}天≥${TRUTH.heavyrain.floor}mm），`)
    lines.push('     与检测判据刻意不同。命中率反映两者的一致程度，不是检测器的绝对正确率。')
    if (worstStation) {
      lines.push(`  3. 数据完整性最低的站为 ${worstStation[0]}（测试期 ${worstStation[1].toFixed(1)}%）。`)
    }
    lines.push(`  4. 本报告结论仅适用于上述 ${stations.size} 个站点，不构成区域性结论。`)

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structured: {
        ok: true, dataRoot,
        dataset: manifest.dataset, region: region.name,
        baseline: rules.baseline_period, test: [ty0, ty1],
        stationCount: stations.size,
        eventTotals: totals,
        metrics: { hit: mH, falseAlarm: mF, miss: mM, hitRate: microRec,
                   falseAlarmRate: P ? mF / P : 0, f1: microF1 },
        firstErrors: firstErrors.slice(0, maxFE),
      },
    }
  },
}
