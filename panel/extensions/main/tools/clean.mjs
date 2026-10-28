// ============================================================================
//  wx_clean — 清洗与插补标记
// ============================================================================
//  本工具的职责边界（重要）：
//    · 只做「标记」和「分类」，绝不静默填补任何观测值
//    · 插补值若存在，必须带 interpolated=true，并在检测阶段降级而非采信
//    · 任何被丢弃的值都必须说明原因
// ============================================================================
import {
  resolveDataRoot, loadManifest, loadRules, loadStations, numOrNull, daysInYear, pad,
} from '../core.mjs'
import { Type, meta } from './schema.mjs'

const parameters = Type.Object({
  dataRoot: Type.Optional(Type.String({ description: '数据集根目录。留空自动定位。' })),
  stationIds: Type.Optional(Type.Array(Type.String(), { description: '只处理指定站号。' })),
  listSuspect: Type.Optional(Type.Integer({
    description: '最多列出多少条可疑记录。默认 20。', minimum: 0, maximum: 500,
  })),
}, { additionalProperties: false })

export const wxClean = {
  name: 'wx_clean',
  description:
    '对已接入的数据做清洗分类：统计缺测、识别可疑值（越界、日均值越界、上游质控标志），' +
    '并报告插补标记的分布。本工具不修改也不填补任何数值——只标记与分类，' +
    '因为静默插补会伪造极端事件。输出每站的清洗报告与可疑记录清单。',
  parameters,
  meta: meta({ deferLoading: false }),
  async execute(args, ctx) {
    const dataRoot = resolveDataRoot(args.dataRoot)
    const manifest = await loadManifest(dataRoot)
    const rules = await loadRules(dataRoot)
    const stations = await loadStations(dataRoot, manifest, args.stationIds?.length ? args.stationIds : undefined)
    const limit = args.listSuspect ?? 20
    ctx?.log?.info?.(`wx_clean: ${stations.size} 站`)

    // 物理合理范围（温带，宽松但足以抓住单位错误与明显错误值）
    const LIMITS = { tmax_c: [-45, 50], tmin_c: [-50, 45], prcp_mm: [0, 400] }

    const lines = []
    lines.push('清洗采用「只标记、不填补」策略：填补会伪造极端事件，因此一律不自动执行。')
    lines.push('')

    let totalSuspect = 0
    let totalMissing = 0
    let totalInterp = 0
    let totalQc = 0
    const perStation = []

    for (const [sid, st] of stations) {
      const counts = { missing: { tmax_c: 0, tmin_c: 0, prcp_mm: 0 }, suspect: 0, interpolated: 0, qcFlagged: 0 }
      const suspectRows = []
      let bothMissing = 0

      for (const r of st.rows) {
        const tx = numOrNull(r.tmax_c)
        const tn = numOrNull(r.tmin_c)
        const pr = numOrNull(r.prcp_mm)
        if (tx === null) counts.missing.tmax_c++
        if (tn === null) counts.missing.tmin_c++
        if (pr === null) counts.missing.prcp_mm++
        if (tx === null && pr === null) bothMissing++
        if (r.interpolated === 'true') counts.interpolated++
        if (r.qc_flag !== '') counts.qcFlagged++

        const reasons = []
        for (const [key, [lo, hi]] of Object.entries(LIMITS)) {
          const v = numOrNull(r[key])
          if (v !== null && (v < lo || v > hi)) reasons.push(`${key}=${v} 越界 [${lo},${hi}]`)
        }
        if (tx !== null && tn !== null && tx < tn) reasons.push(`tmax(${tx}) < tmin(${tn})`)
        if (reasons.length) {
          counts.suspect++
          if (suspectRows.length < limit) suspectRows.push({ date: r.date, reasons })
        }
      }

      const y0 = Number(st.rows[0].date.slice(0, 4))
      const y1 = Number(st.rows[st.rows.length - 1].date.slice(0, 4))
      let expected = 0
      for (let y = y0; y <= y1; y++) expected += daysInYear(y)
      const missingDays = bothMissing
      const pctMissing = expected ? (100 * missingDays / expected) : 0

      lines.push(`${pad(sid, 8)}${pad(st.meta?.name ?? '', 30)} 记录 ${st.rows.length}`)
      lines.push(`         缺测  tmax ${counts.missing.tmax_c}  tmin ${counts.missing.tmin_c}  prcp ${counts.missing.prcp_mm}` +
                 `   两者皆缺 ${missingDays} 天 (${pctMissing.toFixed(1)}%)`)
      lines.push(`         标记  插补 ${counts.interpolated}   上游质控标志 ${counts.qcFlagged}   可疑 ${counts.suspect}`)
      for (const s of suspectRows.slice(0, 5)) {
        lines.push(`           · ${s.date}  ${s.reasons.join('; ')}`)
      }
      if (counts.suspect > 5) lines.push(`           · ... 另有 ${counts.suspect - 5} 条`)
      lines.push('')

      totalSuspect += counts.suspect
      totalMissing += missingDays
      totalInterp += counts.interpolated
      totalQc += counts.qcFlagged
      perStation.push({
        stationId: sid, records: st.rows.length,
        missingBoth: missingDays, missingPct: Number(pctMissing.toFixed(2)),
        suspect: counts.suspect, interpolated: counts.interpolated, qcFlagged: counts.qcFlagged,
      })
    }

    lines.push('─'.repeat(72))
    lines.push(`合计：两者皆缺 ${totalMissing} 天 | 可疑 ${totalSuspect} 条 | 插补标记 ${totalInterp} | 质控标志 ${totalQc}`)
    lines.push('')
    lines.push('处置约定：')
    lines.push('  · 缺测日不参与检测，也不参与阈值计算（阈值计算本就只用基线期）')
    lines.push('  · interpolated=true 的日期在检测中降级，不单独构成事件')
    lines.push('  · 可疑记录保留原值并标记，由 wx_report 在报告中披露，不静默丢弃')

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structured: {
        ok: true, dataRoot,
        totals: { missingBoth: totalMissing, suspect: totalSuspect, interpolated: totalInterp, qcFlagged: totalQc },
        stations: perStation,
      },
    }
  },
}
