// ============================================================================
//  Aurora 核心库 —— 极端天气检测
// ============================================================================
//  纯函数，零依赖。六个 wx_* 工具共用这一份实现。
//
//  设计约束（见 tools/data-source-adapter.md）：
//    · 只读统一数据契约，不碰任何上游原始格式
//    · 不在代码里判断数据来源或地区，站点与判据一律来自 manifest/event_rules
//    · 阈值只用基线期算；测试期数据绝不参与阈值计算
// ============================================================================

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, isAbsolute, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 数据根目录解析 ────────────────────────────────────────────────────────
// 优先环境变量，其次依次尝试若干相对位置，最后退回本文件所在包的 dataset/。
// core.mjs 位于 <包>/extensions/main/，数据集在 <包>/dataset/
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..', '..')
const BUNDLE_ROOT = resolve(PKG, '..')

export function resolveDataRoot(explicit) {
  if (explicit) return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit)
  const env = process.env.AURORA_DATA_ROOT || process.env.WX_DATA_ROOT
  if (env) return isAbsolute(env) ? env : resolve(process.cwd(), env)
  const candidates = [
    join(PKG, 'dataset'),
    join(BUNDLE_ROOT, 'dataset'),
    join(process.cwd(), 'dataset'),
    join(process.cwd(), 'DeepBlue', 'dataset'),
  ]
  for (const c of candidates) {
    if (existsSync(join(c, 'manifest.json'))) return c
  }
  return candidates[0]
}

// ── 日期工具 ──────────────────────────────────────────────────────────────
export function toDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}
export function iso(d) {
  return d.toISOString().slice(0, 10)
}
export function addDays(d, n) {
  const x = new Date(d.getTime())
  x.setUTCDate(x.getUTCDate() + n)
  return x
}
export function dayDiff(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 86400000)
}
/** 年内第几天，2 月 29 日归入 doy 59（冻结的闰年规则）。 */
export function doyKey(d) {
  const m = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  if (m === 2 && day === 29) return 59
  const start = Date.UTC(d.getUTCFullYear(), 0, 1)
  return Math.round((d.getTime() - start) / 86400000) + 1
}
export function daysInYear(y) {
  return (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 366 : 365
}

// ── 统计 ──────────────────────────────────────────────────────────────────
export function quantile(values, p) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const i = Math.round(p * (s.length - 1))
  return s[Math.min(s.length - 1, Math.max(0, i))]
}
export function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

// ── CSV ───────────────────────────────────────────────────────────────────
/** 解析简单的双引号 CSV。返回对象数组。 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length)
  if (!lines.length) return []
  const split = (line) => {
    const out = []
    let cur = ''
    let q = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (q) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++ } else q = false
        } else cur += c
      } else if (c === '"') q = true
      else if (c === ',') { out.push(cur); cur = '' }
      else cur += c
    }
    out.push(cur)
    return out
  }
  const header = split(lines[0])
  return lines.slice(1).map((line) => {
    const cells = split(line)
    const row = {}
    header.forEach((k, i) => { row[k] = cells[i] ?? '' })
    return row
  })
}

// ── 数据载入 ──────────────────────────────────────────────────────────────
export async function loadManifest(dataRoot) {
  return JSON.parse(await readFile(join(dataRoot, 'manifest.json'), 'utf8'))
}
export async function loadRules(dataRoot) {
  return JSON.parse(await readFile(join(dataRoot, 'event_rules.json'), 'utf8'))
}

/**
 * 载入全部站点日表。返回 Map<stationId, { meta, rows, byDate }>。
 * rows 已按日期升序；byDate 为 Map<'YYYY-MM-DD', row>。
 */
export async function loadStations(dataRoot, manifest, stationFilter) {
  const stations = new Map()
  const dir = join(dataRoot, 'daily')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.csv'))
  const want = manifest.stations.map((s) => s.station_id)
  for (const f of files) {
    const sid = f.slice(0, -4)
    if (!want.includes(sid)) continue
    if (stationFilter && !stationFilter.includes(sid)) continue
    const meta = manifest.stations.find((s) => s.station_id === sid)
    const rows = parseCsv(await readFile(join(dir, f), 'utf8'))
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const byDate = new Map(rows.map((r) => [r.date, r]))
    stations.set(sid, { meta, rows, byDate })
  }
  return stations
}

export function numOrNull(v) {
  return v === '' || v === undefined || v === null ? null : Number(v)
}

// ── 阈值 ──────────────────────────────────────────────────────────────────
/**
 * 计算每个 doy 的 ±window 天窗口分位数。
 * 只用 baseline 年份——这是硬约束，测试期数据不得进入。
 */
export function windowThresholds(stations, element, pctl, baseline, windowDays) {
  const [y0, y1] = baseline
  const out = new Map()
  for (const [sid, st] of stations) {
    const buckets = new Map()
    for (const r of st.rows) {
      const y = Number(r.year)
      if (y < y0 || y > y1) continue
      const v = numOrNull(r[element])
      if (v === null) continue
      const k = doyKey(toDate(r.date))
      if (!buckets.has(k)) buckets.set(k, [])
      buckets.get(k).push(v)
    }
    const thr = new Map()
    const samples = new Map()
    for (let k = 1; k <= 366; k++) {
      const vals = []
      for (let off = -windowDays; off <= windowDays; off++) {
        let kk = k + off
        if (kk < 1) kk += 365
        else if (kk > 366) kk -= 366
        const b = buckets.get(kk)
        if (b) vals.push(...b)
      }
      thr.set(k, quantile(vals, pctl))
      samples.set(k, vals.length)
    }
    out.set(sid, { thr, samples })
  }
  return out
}

// ── 事件检测 ──────────────────────────────────────────────────────────────
/** 把 [date, hit] 序列按连续天数折叠成事件段。 */
export function collapseRuns(seq, minLen) {
  const out = []
  let cur = []
  let prev = null
  for (const [d, hit] of seq) {
    const contiguous = prev !== null && dayDiff(d, prev) === 1
    if (hit) {
      if (contiguous && cur.length) cur.push(d)
      else {
        if (cur.length >= minLen) out.push({ start: cur[0], end: cur[cur.length - 1], days: cur.length })
        cur = [d]
      }
    } else {
      if (cur.length >= minLen) out.push({ start: cur[0], end: cur[cur.length - 1], days: cur.length })
      cur = []
    }
    prev = d
  }
  if (cur.length >= minLen) out.push({ start: cur[0], end: cur[cur.length - 1], days: cur.length })
  return out
}

/** 阈值型事件（热浪 / 寒潮）。 */
export function detectThresholdEvents(stations, thresholds, element, floor, direction, years, minDays) {
  const out = new Map()
  for (const [sid, st] of stations) {
    const { thr, samples } = thresholds.get(sid)
    const seq = []
    const insufficient = []
    for (const r of st.rows) {
      const y = Number(r.year)
      if (!years.includes(y)) continue
      const v = numOrNull(r[element])
      if (v === null) continue
      const k = doyKey(toDate(r.date))
      if ((samples.get(k) ?? 0) < 1) { insufficient.push(r.date); continue }
      const t = thr.get(k)
      let hit = t !== null && (direction === 'ge' ? v >= t : v <= t)
      if (hit) hit = direction === 'ge' ? v >= floor : v <= floor
      seq.push([toDate(r.date), hit])
    }
    out.set(sid, { events: collapseRuns(seq, minDays), skippedNoThreshold: insufficient.length })
  }
  return out
}

/** 累计型事件（暴雨）：滑动窗口累计降水。 */
export function detectAccumEvents(stations, floor, years, windowDays, mergeGap) {
  const out = new Map()
  for (const [sid, st] of stations) {
    const ks = st.rows
      .filter((r) => years.includes(Number(r.year)) && numOrNull(r.prcp_mm) !== null)
      .map((r) => ({ d: toDate(r.date), v: Number(r.prcp_mm) }))
    const hits = []
    for (let i = 0; i + windowDays - 1 < ks.length; i++) {
      let contiguous = true
      for (let j = 0; j < windowDays - 1; j++) {
        if (dayDiff(ks[i + j + 1].d, ks[i + j].d) !== 1) { contiguous = false; break }
      }
      if (!contiguous) continue
      let sum = 0
      let complete = true
      for (let j = 0; j < windowDays; j++) {
        if (ks[i + j].v === null) { complete = false; break }
        sum += ks[i + j].v
      }
      if (complete && sum >= floor) hits.push(ks[i].d)
    }
    const out2 = []
    let cur = []
    let prev = null
    for (const d of hits) {
      if (prev !== null && dayDiff(d, prev) <= mergeGap) cur.push(d)
      else {
        if (cur.length) out2.push({ start: cur[0], end: cur[cur.length - 1], hits: cur.length })
        cur = [d]
      }
      prev = d
    }
    if (cur.length) out2.push({ start: cur[0], end: cur[cur.length - 1], hits: cur.length })
    out.set(sid, { events: out2 })
  }
  return out
}

// ── 格式化 ────────────────────────────────────────────────────────────────
export function fmtEvent(e) {
  const s = iso(e.start)
  const t = iso(e.end)
  return s === t ? s : `${s}..${t}`
}
export function pad(s, n) {
  const str = String(s)
  return str.length >= n ? str : str + ' '.repeat(n - str.length)
}
export function padStart(s, n) {
  const str = String(s)
  return str.length >= n ? str : ' '.repeat(n - str.length) + str
}
