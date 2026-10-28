// 指标服务自测：不经过 AGH，直接算，核对数字合理性
import { computeMetrics } from './extensions/main/metrics.mjs'

const t0 = Date.now()
const m = await computeMetrics()
const t1 = Date.now()
console.log(`首次计算 ${t1 - t0} ms`)
console.log()

if (!m.ok) {
  console.log('** ok=false **', m.error)
  process.exit(1)
}

const checks = []
const ck = (name, cond, detail) => { checks.push([name, cond, detail]) }

ck('站点数 = 12', m.region.stationCount === 12, m.region.stationCount)
ck('海拔范围存在', m.region.elevMin != null && m.region.elevMax != null,
   `${m.region.elevMin}–${m.region.elevMax}`)
ck('分区合计 = 站点数',
   Object.values(m.region.zones).reduce((a, b) => a + b, 0) === m.region.stationCount,
   JSON.stringify(m.region.zones))
ck('时段到 2025', String(m.dataset.last).startsWith('2025'), m.dataset.last)
ck('基线完整度 >= 95', m.dataset.minBaselinePct >= 95, m.dataset.minBaselinePct)
ck('测试完整度 >= 95', m.dataset.minTestPct >= 95, m.dataset.minTestPct)
ck('窗口样本 >= 30', m.thresholds.sampleMin >= 30, `${m.thresholds.sampleMin}–${m.thresholds.sampleMax}`)
ck('三类事件都检出', m.detected.heatwave > 0 && m.detected.coldwave > 0 && m.detected.heavyrain > 0,
   JSON.stringify(m.detected))
ck('指标非零', m.metrics.hit > 0, JSON.stringify(m.metrics))
ck('校验项 = 7', m.validation.length === 7, m.validation.length)
ck('最近事件非空', m.recent.length > 0, m.recent.length)
ck('年际序列非空', (m.yearSeries ?? []).length > 0, (m.yearSeries ?? []).length)
ck('年际序列覆盖完整年份',
   (() => {
     const ys = m.yearSeries ?? []
     if (!ys.length) return false
     for (let i = 1; i < ys.length; i++) if (ys[i].year !== ys[i - 1].year + 1) return false
     return true
   })(),
   (m.yearSeries ?? []).length
     ? `${m.yearSeries[0].year}–${m.yearSeries[m.yearSeries.length - 1].year}`
     : '空')
ck('年际合计 = 检出合计',
   (m.yearSeries ?? []).reduce((a, s) => a + s.total, 0) ===
   (m.detected.heatwave + m.detected.coldwave + m.detected.heavyrain),
   `${(m.yearSeries ?? []).reduce((a, s) => a + s.total, 0)} vs ` +
   `${m.detected.heatwave + m.detected.coldwave + m.detected.heavyrain}`)
ck('峰值年存在', m.busiestYear != null && m.busiestYear.total > 0, JSON.stringify(m.busiestYear))
ck('站点明细 = 12', m.stations.length === 12, m.stations.length)
ck('六个工具', m.tools.length === 6 && m.tools.every((t) => t.ready), m.tools.length)

console.log('=== 校验 ===')
let bad = 0
for (const [n, ok, d] of checks) {
  if (!ok) bad++
  console.log(`  ${ok ? 'OK  ' : '**FAIL**'} ${n}  (${d})`)
}

console.log()
console.log('=== 实测数字 ===')
console.log('  区域       :', m.region.name, JSON.stringify(m.region.box))
console.log('  站点/海拔  :', m.region.stationCount, '/', m.region.elevMin + '-' + m.region.elevMax + 'm')
console.log('  分区       :', JSON.stringify(m.region.zones))
console.log('  时段       :', m.dataset.first, '..', m.dataset.last)
console.log('  基线/测试  :', m.periods.baseline.join('–'), '/', m.periods.test.join('–'))
console.log('  完整度     : 基线', m.dataset.minBaselinePct, '%  测试', m.dataset.minTestPct, '%')
console.log('  判据       : 热浪', m.thresholds.heatwave.floor, '| 寒潮', m.thresholds.coldwave.floor,
            '| 暴雨', m.thresholds.heavyrain.floor)
console.log('  窗口样本   :', m.thresholds.sampleMin, '–', m.thresholds.sampleMax)
console.log('  检出       :', JSON.stringify(m.detected))
console.log('  指标       : 命中率', (m.metrics.hitRate * 100).toFixed(1) + '%',
            ' 误报率', (m.metrics.falseAlarmRate * 100).toFixed(1) + '%',
            ' 漏报率', (m.metrics.missRate * 100).toFixed(1) + '%',
            ' F1', m.metrics.f1)
console.log('  判据校验   :')
for (const v of m.validation) console.log(`      ${v.ok ? 'OK  ' : '弱  '} ${v.label}  ${v.hit}/${v.total}`)
console.log('  最近事件   :')
for (const e of m.recent.slice(0, 6)) {
  console.log(`      ${e.kind.padEnd(10)} ${e.start}${e.start === e.end ? '' : '..' + e.end}  ${e.stationName}`)
}
if ((m.yearSeries ?? []).length) {
  const ys = m.yearSeries
  console.log('  年际分布   :', `${ys[0].year}–${ys[ys.length - 1].year}，共 ${ys.length} 年`)
  console.log('     峰值   :', m.busiestYear ? `${m.busiestYear.year} 年 ${m.busiestYear.total} 次` : '—')
  const max = Math.max(...ys.map((s) => s.total))
  for (const s of ys) {
    const bar = '█'.repeat(Math.round((s.total / Math.max(max, 1)) * 24))
    console.log(`     ${s.year} ${String(s.total).padStart(3)} ${bar}`)
  }
}
const bytes = Buffer.byteLength(JSON.stringify(m))
console.log('  返回体大小 :', bytes, 'bytes  (maxResultBytes=262144)')
ck('返回体 < 256 KiB', bytes < 262144, bytes)

console.log()
const t2 = Date.now()
const m2 = await computeMetrics()
console.log(`二次调用 ${Date.now() - t2} ms   cached=${m2.cached}`)
ck('缓存生效', m2.cached === true, m2.cached)

console.log()
console.log(bad === 0 ? 'METRICS-SELFTEST PASS' : `METRICS-SELFTEST FAIL (${bad} 项)`)
process.exit(bad === 0 ? 0 : 1)
