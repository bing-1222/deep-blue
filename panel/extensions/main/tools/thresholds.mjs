// ============================================================================
//  wx_thresholds — 基线期阈值
// ============================================================================
//  硬约束：阈值只能用基线期计算。测试期数据一旦进入阈值计算，
//  回测就变成自我实现的循环，整个验证失去意义。
// ============================================================================
import {
  resolveDataRoot, loadManifest, loadRules, loadStations, numOrNull,
  windowThresholds, quantile, pad, padStart,
} from '../core.mjs'
import { Type, meta } from './schema.mjs'

const parameters = Type.Object({
  dataRoot: Type.Optional(Type.String({ description: '数据集根目录。留空自动定位。' })),
  stationIds: Type.Optional(Type.Array(Type.String(), { description: '只处理指定站号。' })),
  doy: Type.Optional(Type.Array(Type.Integer({
    description: '只显示这些 doy（1–366）的阈值。留空则只输出汇总。',
    minimum: 1, maximum: 366,
  }))),
}, { additionalProperties: false })

export const wxThresholds = {
  name: 'wx_thresholds',
  description:
    '用基线期数据计算每个站、每个 doy 的滑动窗口阈值（默认前后各 15 天）。' +
    '输出窗口样本量、分位数取值与数据充分性判定。' +
    '严格只用基线期年份，测试期数据绝不参与——否则回测将失去验证意义。' +
    '阈值结果供 wx_detect 使用。',
  parameters,
  meta: meta({ deferLoading: false }),
  async execute(args, ctx) {
    const dataRoot = resolveDataRoot(args.dataRoot)
    const manifest = await loadManifest(dataRoot)
    const rules = await loadRules(dataRoot)
    const stations = await loadStations(dataRoot, manifest, args.stationIds?.length ? args.stationIds : undefined)
    const [b0, b1] = rules.baseline_period
    const wd = rules.window_days
    const minS = rules.min_samples
    ctx?.log?.info?.(`wx_thresholds: baseline ${b0}-${b1}, window ±${wd}`)

    const tHW = windowThresholds(stations, 'tmax_c', rules.heatwave.window_pctl, rules.baseline_period, wd)
    const tCW = windowThresholds(stations, 'tmin_c', rules.coldwave.window_pctl, rules.baseline_period, wd)

    const lines = []
    lines.push(`基线期  ${b0}–${b1}   （测试期 ${rules.test_period.join('–')} 不参与计算）`)
    lines.push(`窗口    ±${wd} 天   最小样本 ${minS}`)
    lines.push(`判据    热浪 tmax ≥ P${(rules.heatwave.window_pctl * 100).toFixed(0)} 且 ≥ ${rules.heatwave.abs_floor}°C`)
    lines.push(`        寒潮 tmin ≤ P${(rules.coldwave.window_pctl * 100).toFixed(0)} 且 ≤ ${rules.coldwave.abs_floor}°C`)
    lines.push(`        暴雨 ${rules.heavy_rain.accum_days} 天累计 ≥ ${rules.heavy_rain.abs_floor} mm`)
    lines.push('')

    lines.push(`${pad('站号', 8)}${pad('海拔', 7)}${pad('样本min', 9)}${pad('样本max', 9)}` +
               `${pad('热浪阈中位', 12)}${pad('寒潮阈中位', 12)}充分性`)
    lines.push('─'.repeat(78))

    const perStation = []
    for (const [sid, st] of stations) {
      const a = tHW.get(sid)
      const b = tCW.get(sid)
      const sa = [...a.samples.values()]
      const sb = [...b.samples.values()]
      const okA = sa.every((n) => n >= minS)
      const okB = sb.every((n) => n >= minS)
      const medA = quantile([...a.thr.values()].filter((v) => v !== null), 0.5)
      const medB = quantile([...b.thr.values()].filter((v) => v !== null), 0.5)
      lines.push(
        `${pad(sid, 8)}${pad(st.meta?.elev_m ?? '?', 7)}` +
        `${pad(Math.min(...sa), 9)}${pad(Math.max(...sa), 9)}` +
        `${pad(medA === null ? '—' : medA.toFixed(1), 12)}` +
        `${pad(medB === null ? '—' : medB.toFixed(1), 12)}` +
        `${okA && okB ? 'OK' : '**样本不足**'}`)
      perStation.push({
        stationId: sid, elevM: st.meta?.elev_m,
        tmaxSampleMin: Math.min(...sa), tmaxSampleMax: Math.max(...sa),
        tminSampleMin: Math.min(...sb), tminSampleMax: Math.max(...sb),
        heatwaveThresholdMedian: medA, coldwaveThresholdMedian: medB,
        sufficient: okA && okB,
      })
    }

    if (args.doy?.length) {
      lines.push('')
      lines.push(`=== 指定 doy 的阈值明细 ===`)
      for (const k of args.doy) {
        lines.push(`doy ${k}`)
        for (const [sid] of stations) {
          const a = tHW.get(sid)
          const b = tCW.get(sid)
          lines.push(`  ${pad(sid, 8)} 热浪 ${pad(a.thr.get(k)?.toFixed(1) ?? '—', 8)}` +
                     ` (n=${pad(a.samples.get(k) ?? 0, 4)})   寒潮 ${pad(b.thr.get(k)?.toFixed(1) ?? '—', 8)}` +
                     ` (n=${pad(b.samples.get(k) ?? 0, 4)})`)
        }
      }
    }

    lines.push('')
    lines.push('下一步：调用 wx_detect 用这些阈值在测试期检出事件。')

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structured: {
        ok: true, dataRoot, baseline: rules.baseline_period,
        windowDays: wd, minSamples: minS, stations: perStation,
      },
    }
  },
}
