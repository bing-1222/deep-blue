// 核心库自测：与已冻结的判据和已知事件对照
import { resolveDataRoot, loadManifest, loadRules, loadStations,
         windowThresholds, detectThresholdEvents, detectAccumEvents, collapseRuns,
         quantile, toDate, iso, doyKey } from './extensions/main/core.mjs'

const DATA = resolveDataRoot()
console.log('dataRoot =', DATA)

const manifest = await loadManifest(DATA)
const rules = await loadRules(DATA)
const stations = await loadStations(DATA, manifest)

console.log('stations =', stations.size)
console.log('rules    =', JSON.stringify({
  hw: rules.heatwave.abs_floor, cw: rules.coldwave.abs_floor, hr: rules.heavy_rain.abs_floor,
  baseline: rules.baseline_period, test: rules.test_period,
}))

const base = rules.baseline_period
const wd = rules.window_days
const [ty0, ty1] = rules.test_period
const testYears = []
for (let y = ty0; y <= ty1; y++) testYears.push(y)
const allYears = []
for (let y = 2000; y <= 2025; y++) allYears.push(y)

// ── 阈值 ──
const tHW = windowThresholds(stations, 'tmax_c', rules.heatwave.window_pctl, base, wd)
const tCW = windowThresholds(stations, 'tmin_c', rules.coldwave.window_pctl, base, wd)

let minS = Infinity, maxS = -Infinity
for (const [, v] of tHW) {
  for (const [, n] of v.samples) { if (n < minS) minS = n; if (n > maxS) maxS = n }
}
console.log(`tmax 窗口样本 min=${minS} max=${maxS}  (min_samples=${rules.min_samples})`)

// ── 测试期检出 ──
const hwTest = detectThresholdEvents(stations, tHW, 'tmax_c', rules.heatwave.abs_floor, 'ge', testYears, rules.heatwave.min_days)
const cwTest = detectThresholdEvents(stations, tCW, 'tmin_c', rules.coldwave.abs_floor, 'le', testYears, rules.coldwave.min_days)
const hrTest = detectAccumEvents(stations, rules.heavy_rain.abs_floor, testYears,
                                 rules.heavy_rain.accum_days, rules.heavy_rain.merge_gap_days)

let sHW = 0, sCW = 0, sHR = 0
console.log('\n=== 测试期 2020-2025 检出 ===')
console.log('站号     热浪  寒潮  暴雨')
for (const [sid] of stations) {
  const a = hwTest.get(sid).events.length
  const b = cwTest.get(sid).events.length
  const c = hrTest.get(sid).events.length
  sHW += a; sCW += b; sHR += c
  console.log(`${sid}  ${String(a).padStart(4)} ${String(b).padStart(5)} ${String(c).padStart(5)}`)
}
console.log(`合计      ${String(sHW).padStart(4)} ${String(sCW).padStart(5)} ${String(sHR).padStart(5)}`)

// ── 已知事件复现 ──
const KNOWN = [
  ['寒潮', '2012-02-06', cwTest, tCW, 'tmin_c', 'le', rules.coldwave.abs_floor, rules.coldwave.min_days],
  ['寒潮', '2009-12-19', cwTest, tCW, 'tmin_c', 'le', rules.coldwave.abs_floor, rules.coldwave.min_days],
  ['寒潮', '2021-02-14', cwTest, tCW, 'tmin_c', 'le', rules.coldwave.abs_floor, rules.coldwave.min_days],
  ['寒潮', '2018-02-28', cwTest, tCW, 'tmin_c', 'le', rules.coldwave.abs_floor, rules.coldwave.min_days],
  ['热浪', '2019-07-25', hwTest, tHW, 'tmax_c', 'ge', rules.heatwave.abs_floor, rules.heatwave.min_days],
  ['热浪', '2018-08-09', hwTest, tHW, 'tmax_c', 'ge', rules.heatwave.abs_floor, rules.heatwave.min_days],
  ['热浪', '2015-08-07', hwTest, tHW, 'tmax_c', 'ge', rules.heatwave.abs_floor, rules.heatwave.min_days],
  ['热浪', '2022-07-20', hwTest, tHW, 'tmax_c', 'ge', rules.heatwave.abs_floor, rules.heatwave.min_days],
]

// 全期重跑一遍用于复现检验
const hwAll = detectThresholdEvents(stations, tHW, 'tmax_c', rules.heatwave.abs_floor, 'ge', allYears, rules.heatwave.min_days)
const cwAll = detectThresholdEvents(stations, tCW, 'tmin_c', rules.coldwave.abs_floor, 'le', allYears, rules.coldwave.min_days)

console.log('\n=== 已知事件复现（全期 2000-2025 检测）===')
const expected = { '2012-02-06': 12, '2009-12-19': 12, '2021-02-14': 9, '2018-02-28': 4,
                   '2019-07-25': 10, '2018-08-09': 12, '2015-08-07': 6, '2022-07-20': 6 }
let allOk = true
for (const [kind, day, , , , , , ] of KNOWN) {
  const pool = kind === '寒潮' ? cwAll : hwAll
  const target = toDate(day)
  let hit = 0
  for (const [, v] of pool) {
    if (v.events.some((e) => e.start <= target && target <= e.end)) hit++
  }
  const exp = expected[day]
  const ok = hit === exp
  if (!ok) allOk = false
  console.log(`  ${kind} ${day}  ${String(hit).padStart(2)}/${stations.size}  期望 ${String(exp).padStart(2)}  ${ok ? 'OK' : '**不符**'}`)
}

console.log('\n' + (allOk ? 'SELF-TEST PASS: 核心库与 Python 参考实现一致' : 'SELF-TEST FAIL: 与 Python 参考实现不一致'))
process.exit(allOk ? 0 : 1)
