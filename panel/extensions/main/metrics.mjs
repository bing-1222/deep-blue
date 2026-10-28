// ============================================================================
//  metrics.mjs — 为前端面板现算真实指标
// ============================================================================
//  设计要点：
//    · 数字全部由数据集现算，不写死；面板 CONFIG 里的不再是"静态文案"
//    · 结果按数据集文件 mtime + 判据文件 mtime 缓存，重复调用不重算
//    · 计算量在首次调用时完成（12 站 × 9.5 千行 ≈ 11 万行），之后走缓存
// ============================================================================
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  resolveDataRoot, loadManifest, loadRules, loadStations, numOrNull, daysInYear,
  windowThresholds, detectThresholdEvents, detectAccumEvents, collapseRuns,
  quantile, toDate, iso, dayDiff,
} from './core.mjs'

// ── 与 wx_backtest 一致的独立真值口径 ─────────────────────────────────────
const TRUTH = {
  heatwave: { elem: 'tmax_c', floor: 30.0, minDays: 3, dir: 'ge' },
  coldwave: { elem: 'tmin_c', floor: -10.0, minDays: 3, dir: 'le' },
  heavyrain: { accumDays: 3, floor: 50.0, mergeGap: 3 },
}

/** 已知历史事件（用于面板展示判据复现） */
const KNOWN = [
  { label: '寒潮 2012-02-06', day: '2012-02-06', kind: 'coldwave' },
  { label: '寒潮 2009-12-19', day: '2009-12-19', kind: 'coldwave' },
  { label: '寒潮 2021-02-14', day: '2021-02-14', kind: 'coldwave' },
  { label: '热浪 2019-07-25', day: '2019-07-25', kind: 'heatwave' },
  { label: '热浪 2018-08-09', day: '2018-08-09', kind: 'heatwave' },
  { label: '热浪 2015-08-07', day: '2015-08-07', kind: 'heatwave' },
  { label: '热浪 2022-07-20', day: '2022-07-20', kind: 'heatwave' },
]

let CACHE = { key: null, value: null }

/** 数据集与判据的 mtime 指纹，任一变化就重算 */
async function fingerprint(dataRoot) {
  const parts = []
  for (const f of ['manifest.json', 'event_rules.json']) {
    try { parts.push(f + ':' + (await stat(join(dataRoot, f))).mtimeMs) } catch { parts.push(f + ':?') }
  }
  try {
    const dir = join(dataRoot, 'daily')
    const files = (await readdir(dir)).filter((f) => f.endsWith('.csv')).sort()
    parts.push('daily:' + files.length)
    // 只取首末两个文件的 mtime，避免 12 次 stat
    for (const f of [files[0], files[files.length - 1]]) {
      if (f) parts.push(f + ':' + (await stat(join(dir, f))).mtimeMs)
    }
  } catch { parts.push('daily:?') }
  return parts.join('|')
}

function expand(events) {
  const s = new Set()
  for (const e of events) {
    let d = e.start
    while (d <= e.end) { s.add(iso(d)); d = new Date(d.getTime() + 86400000) }
  }
  return s
}

/**
 * 计算面板所需的全部指标。返回值为可 JSON 序列化的普通对象。
 */
export async function computeMetrics(dataRootOpt) {
  const dataRoot = resolveDataRoot(dataRootOpt)
  const fp = await fingerprint(dataRoot)
  if (CACHE.key === fp && CACHE.value) {
    return { ...CACHE.value, cached: true }
  }

  const manifest = await loadManifest(dataRoot)
  const rules = await loadRules(dataRoot)
  const stations = await loadStations(dataRoot, manifest)
  const region = manifest.regions?.[0] ?? {}
  const [b0, b1] = rules.baseline_period
  const [t0, t1] = rules.test_period
  const wd = rules.window_days

  // ── 逐站完整度（基线期 / 测试期）────────────────────────────────────────
  const perStation = []
  let elevMin = Infinity, elevMax = -Infinity
  const zones = {}
  for (const [sid, st] of stations) {
    const m = st.meta ?? {}
    if (m.elev_m != null) { elevMin = Math.min(elevMin, m.elev_m); elevMax = Math.max(elevMax, m.elev_m) }
    if (m.zone) zones[m.zone] = (zones[m.zone] ?? 0) + 1

    const count = (y0, y1) => st.rows.filter((r) => {
      const y = Number(r.year)
      return y >= y0 && y <= y1 && numOrNull(r.tmax_c) !== null && numOrNull(r.prcp_mm) !== null
    }).length
    let expB = 0; for (let y = b0; y <= b1; y++) expB += daysInYear(y)
    let expT = 0; for (let y = t0; y <= t1; y++) expT += daysInYear(y)
    perStation.push({
      stationId: sid,
      name: m.name ?? sid,
      elevM: m.elev_m ?? null,
      zone: m.zone ?? null,
      first: st.rows[0]?.date ?? null,
      last: st.rows[st.rows.length - 1]?.date ?? null,
      baselinePct: Number((100 * count(b0, b1) / expB).toFixed(2)),
      testPct: Number((100 * count(t0, t1) / expT).toFixed(2)),
    })
  }
  const withCap = perStation.filter((s) => s.stationId)
  const anyStation = withCap[0] ?? {}
  const allFirst = withCap.map((s) => s.first).filter(Boolean).sort()[0] ?? null
  const allLast = withCap.map((s) => s.last).filter(Boolean).sort().slice(-1)[0] ?? null
  const minPct = Math.min(...withCap.map((s) => s.baselinePct))
  const minTestPct = Math.min(...withCap.map((s) => s.testPct))

  // ── 阈值可算性（抽样若干 doy，全算 366 个太慢）─────────────────────────
  const tHW = windowThresholds(stations, 'tmax_c', rules.heatwave.window_pctl, rules.baseline_period, wd)
  const tCW = windowThresholds(stations, 'tmin_c', rules.coldwave.window_pctl, rules.baseline_period, wd)
  let sampleMin = Infinity, sampleMax = -Infinity
  for (const [, v] of tHW) {
    for (const [, n] of v.samples) { if (n < sampleMin) sampleMin = n; if (n > sampleMax) sampleMax = n }
  }

  // ── 检测（测试期）──────────────────────────────────────────────────────
  const testYears = []; for (let y = t0; y <= t1; y++) testYears.push(y)
  const allYears = []; for (let y = 2000; y <= 2025; y++) allYears.push(y)

  const dHW = detectThresholdEvents(stations, tHW, 'tmax_c', rules.heatwave.abs_floor, 'ge', testYears, rules.heatwave.min_days)
  const dCW = detectThresholdEvents(stations, tCW, 'tmin_c', rules.coldwave.abs_floor, 'le', testYears, rules.coldwave.min_days)
  const dHR = detectAccumEvents(stations, rules.heavy_rain.abs_floor, testYears,
    rules.heavy_rain.accum_days, rules.heavy_rain.merge_gap_days)

  const totals = { heatwave: 0, coldwave: 0, heavyrain: 0 }
  for (const [sid] of stations) {
    totals.heatwave += dHW.get(sid)?.events.length ?? 0
    totals.coldwave += dCW.get(sid)?.events.length ?? 0
    totals.heavyrain += dHR.get(sid)?.events.length ?? 0
  }

  // ── 真值与指标 ─────────────────────────────────────────────────────────
  const tHWt = {}, tCWt = {}, tHRt = {}
  for (const [sid, st] of stations) {
    const sh = [], sc = []
    for (const r of st.rows) {
      const y = Number(r.year)
      if (y < t0 || y > t1) continue
      const tx = numOrNull(r.tmax_c), tn = numOrNull(r.tmin_c)
      if (tx !== null) sh.push([toDate(r.date), tx >= TRUTH.heatwave.floor])
      if (tn !== null) sc.push([toDate(r.date), tn <= TRUTH.coldwave.floor])
    }
    tHWt[sid] = collapseRuns(sh, TRUTH.heatwave.minDays)
    tCWt[sid] = collapseRuns(sc, TRUTH.coldwave.minDays)

    const ks = st.rows.filter((r) => {
      const y = Number(r.year)
      return y >= t0 && y <= t1 && numOrNull(r.prcp_mm) !== null
    }).map((r) => ({ d: toDate(r.date), v: Number(r.prcp_mm) }))
    const hits = []
    for (let i = 0; i + 2 < ks.length; i++) {
      if (dayDiff(ks[i + 1].d, ks[i].d) !== 1 || dayDiff(ks[i + 2].d, ks[i].d) !== 2) continue
      if (ks[i].v + ks[i + 1].v + ks[i + 2].v >= TRUTH.heavyrain.floor) hits.push(ks[i].d)
    }
    const out = []; let cur = []; let prev = null
    for (const d of hits) {
      if (prev !== null && dayDiff(d, prev) <= TRUTH.heavyrain.mergeGap) cur.push(d)
      else { if (cur.length) out.push({ start: cur[0], end: cur[cur.length - 1] }); cur = [d] }
      prev = d
    }
    if (cur.length) out.push({ start: cur[0], end: cur[cur.length - 1] })
    tHRt[sid] = out
  }

  let mH = 0, mF = 0, mM = 0
  for (const [sid] of stations) {
    for (const [det, tru] of [[dHW, tHWt], [dCW, tCWt], [dHR, tHRt]]) {
      const A = expand(det.get(sid)?.events ?? [])
      const B = expand(tru[sid] ?? [])
      let hit = 0
      for (const d of A) if (B.has(d)) hit++
      mH += hit; mF += A.size - hit; mM += B.size - hit
    }
  }
  const P = mH + mF
  const hitRate = (mH + mM) ? mH / (mH + mM) : 0
  const faRate = P ? mF / P : 0
  const f1 = (hitRate + (P ? mH / P : 0)) ? 2 * (P ? mH / P : 0) * hitRate / ((P ? mH / P : 0) + hitRate) : 0

  // ── 已知事件复现（全期检测）────────────────────────────────────────────
  const hwAll = detectThresholdEvents(stations, tHW, 'tmax_c', rules.heatwave.abs_floor, 'ge', allYears, rules.heatwave.min_days)
  const cwAll = detectThresholdEvents(stations, tCW, 'tmin_c', rules.coldwave.abs_floor, 'le', allYears, rules.coldwave.min_days)
  const validation = KNOWN.map((k) => {
    const pool = k.kind === 'heatwave' ? hwAll : cwAll
    const target = toDate(k.day)
    let hit = 0
    for (const [, v] of pool) {
      if (v.events.some((e) => e.start <= target && target <= e.end)) hit++
    }
    return { label: k.label, hit, total: stations.size, ok: hit / stations.size >= 0.5 }
  })

  // ── 最近事件（时间倒序，面板展示用）────────────────────────────────────
  const recent = []
  const byYear = {}          // 年份 -> 事件次数（供面板画年际分布）
  const byYearKind = {}      // 年份 -> { heatwave, coldwave, heavyrain }
  for (const [sid, st] of stations) {
    for (const [kind, store] of [['heatwave', dHW], ['coldwave', dCW], ['heavyrain', dHR]]) {
      for (const e of store.get(sid)?.events ?? []) {
        const start = iso(e.start)
        const end = iso(e.end)
        recent.push({
          stationId: sid, stationName: st.meta?.name ?? sid, kind,
          start, end, days: e.days ?? e.hits ?? null,
        })
        const y = Number(start.slice(0, 4))
        byYear[y] = (byYear[y] ?? 0) + 1
        byYearKind[y] = byYearKind[y] ?? { heatwave: 0, coldwave: 0, heavyrain: 0 }
        byYearKind[y][kind] += 1
      }
    }
  }
  recent.sort((a, b) => (a.start < b.start ? 1 : -1))
  const recentTop = recent.slice(0, 10)

  // 年际序列（只覆盖实际有事件的年份，缺年补 0）
  const yearKeys = Object.keys(byYear).map(Number).sort((a, b) => a - b)
  const yearSeries = []
  if (yearKeys.length) {
    for (let y = yearKeys[0]; y <= yearKeys[yearKeys.length - 1]; y++) {
      yearSeries.push({
        year: y,
        total: byYear[y] ?? 0,
        heatwave: byYearKind[y]?.heatwave ?? 0,
        coldwave: byYearKind[y]?.coldwave ?? 0,
        heavyrain: byYearKind[y]?.heavyrain ?? 0,
      })
    }
  }
  const busiest = yearSeries.slice().sort((a, b) => b.total - a.total)[0] ?? null

  const value = {
    ok: true,
    dataRoot,
    generatedAt: new Date().toISOString(),
    cached: false,
    region: {
      name: region.name ?? null,
      box: region.box ?? null,
      stationCount: stations.size,
      elevMin: Number.isFinite(elevMin) ? elevMin : null,
      elevMax: Number.isFinite(elevMax) ? elevMax : null,
      zones,
    },
    dataset: {
      id: manifest.dataset ?? null,
      adapter: manifest.adapter ?? null,
      source: manifest.upstream?.provider ?? null,
      loginRequired: manifest.upstream?.login_required ?? null,
      first: allFirst,
      last: allLast,
      minBaselinePct: Number.isFinite(minPct) ? minPct : null,
      minTestPct: Number.isFinite(minTestPct) ? minTestPct : null,
    },
    periods: { baseline: rules.baseline_period, test: rules.test_period, windowDays: wd, minSamples: rules.min_samples },
    thresholds: {
      heatwave: { windowPctl: rules.heatwave.window_pctl, floor: rules.heatwave.abs_floor, minDays: rules.heatwave.min_days },
      coldwave: { windowPctl: rules.coldwave.window_pctl, floor: rules.coldwave.abs_floor, minDays: rules.coldwave.min_days },
      heavyrain: { accumDays: rules.heavy_rain.accum_days, floor: rules.heavy_rain.abs_floor },
      sampleMin: Number.isFinite(sampleMin) ? sampleMin : null,
      sampleMax: Number.isFinite(sampleMax) ? sampleMax : null,
    },
    detected: totals,
    metrics: {
      hit: mH, falseAlarm: mF, miss: mM,
      hitRate: Number(hitRate.toFixed(4)),
      falseAlarmRate: Number(faRate.toFixed(4)),
      missRate: Number(((mH + mM) ? mM / (mH + mM) : 0).toFixed(4)),
      f1: Number(f1.toFixed(4)),
    },
    validation,
    recent: recentTop,
    yearSeries,
    busiestYear: busiest ? { year: busiest.year, total: busiest.total } : null,
    stations: perStation,
    tools: [
      { id: 'wx_ingest', label: '数据接入与体检', ready: true },
      { id: 'wx_clean', label: '清洗与插补标记', ready: true },
      { id: 'wx_thresholds', label: '基线期阈值', ready: true },
      { id: 'wx_detect', label: '执行检测', ready: true },
      { id: 'wx_backtest', label: '与实测比对', ready: true },
      { id: 'wx_report', label: '报告与首错定位', ready: true },
    ],
  }

  CACHE = { key: fp, value }
  return value
}

export function clearMetricsCache() {
  CACHE = { key: null, value: null }
}
