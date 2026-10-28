#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
calibrate_criteria.py — 标定并冻结事件判据

用法:
    python calibrate_criteria.py            # 标定并写入 dataset/event_rules.json
    python calibrate_criteria.py --sweep    # 额外打印下限扫描表

判据结构（三段，全部由数据决定）:
    窗口分位数  →  抓「相对该时节是否异常」
    绝对下限    →  抓「是否真的危险」
    持续天数    →  抓「是否构成事件」

标定原则:
    绝对下限按区域扫描，选择使【基线期本身】产出约 0.3–1.5 次/站/年的值。
    既不把常态当极端，也不让判据空转。
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
DATASET = os.path.join(PKG, "dataset")
DAILY = os.path.join(DATASET, "daily")

BASELINE = (2000, 2012)
TEST = (2020, 2025)
WINDOW_DAYS = 15
MIN_SAMPLES = 30
TARGET_PER_STATION_YEAR = (0.3, 1.5)


# ══ 基础 ══════════════════════════════════════════════════════════════════

def load_all() -> dict[str, dict[dt.date, tuple]]:
    out = {}
    for fn in sorted(os.listdir(DAILY)):
        if not fn.endswith(".csv"):
            continue
        rows = {}
        with open(os.path.join(DAILY, fn), encoding="utf-8") as f:
            for r in csv.DictReader(f):
                g = lambda k: None if r[k] == "" else float(r[k])
                rows[dt.date.fromisoformat(r["date"])] = (
                    g("tmax_c"), g("tmin_c"), g("prcp_mm"))
        out[fn[:-4]] = rows
    return out


def doy_key(d: dt.date) -> int:
    """2 月 29 日归入 doy 59 的窗口。"""
    if d.month == 2 and d.day == 29:
        return 59
    return d.timetuple().tm_yday


def quantile(values: list[float], p: float):
    if not values:
        return None
    s = sorted(values)
    i = int(round(p * (len(s) - 1)))
    return s[min(len(s) - 1, max(0, i))]


def window_thresholds(series, idx: int, pctl: float, years: set[int]) -> dict[int, float]:
    """每个 doy 的 ±15 天窗口分位数。"""
    buckets: dict[int, list[float]] = {}
    for d, v in series.items():
        if d.year in years and v[idx] is not None:
            buckets.setdefault(doy_key(d), []).append(v[idx])
    thr = {}
    for k in range(1, 367):
        vals: list[float] = []
        for off in range(-WINDOW_DAYS, WINDOW_DAYS + 1):
            kk = k + off
            if kk < 1:
                kk += 365
            elif kk > 366:
                kk -= 366
            vals.extend(buckets.get(kk, ()))
        thr[k] = quantile(vals, pctl)
    return thr


def runs(seq: list[tuple[dt.date, bool]], minlen: int):
    out, cur, prev = [], [], None
    for d, hit in seq:
        contiguous = prev is not None and (d - prev).days == 1
        if hit:
            cur = cur + [d] if (contiguous and cur) else [d]
        else:
            if len(cur) >= minlen:
                out.append((cur[0], cur[-1], len(cur)))
            cur = []
        prev = d
    if len(cur) >= minlen:
        out.append((cur[0], cur[-1], len(cur)))
    return out


def detect(series, idx: int, pctl: float, floor, cmp_: str,
           years: set[int], minlen: int = 3):
    thr = window_thresholds(series, idx, pctl, set(range(*[BASELINE[0], BASELINE[1] + 1])))
    seq = []
    for d in sorted(series):
        if d.year not in years or series[d][idx] is None:
            continue
        t = thr.get(doy_key(d))
        x = series[d][idx]
        hit = t is not None and ((x >= t) if cmp_ == "ge" else (x <= t))
        if hit and floor is not None:
            hit = (x >= floor) if cmp_ == "ge" else (x <= floor)
        seq.append((d, hit))
    return runs(seq, minlen)


def detect_accum(series, floor: float, years: set[int], win: int = 3, gap: int = 3):
    """滑动窗口累计降水事件；相邻命中合并。"""
    ks = sorted(d for d in series if d.year in years and series[d][2] is not None)
    hits = []
    for i in range(len(ks) - win + 1):
        if not all((ks[i + j + 1] - ks[i + j]).days == 1 for j in range(win - 1)):
            continue
        if sum(series[ks[i + j]][2] for j in range(win)) >= floor:
            hits.append(ks[i])
    out, cur, prev = [], [], None
    for d in hits:
        if prev is not None and (d - prev).days <= gap:
            cur.append(d)
        else:
            if cur:
                out.append((cur[0], cur[-1], len(cur)))
            cur = [d]
        prev = d
    if cur:
        out.append((cur[0], cur[-1], len(cur)))
    return out


def per_station_year(total_events: int, n_stations: int, years: int) -> float:
    return total_events / (n_stations * years)


def pick_floor(D, kind: str, candidates: list[float]) -> tuple[float, list[tuple]]:
    """扫描候选下限，选落在目标频率区间内、且最接近中值的那个。"""
    nyears = BASELINE[1] - BASELINE[0] + 1
    table = []
    for fl in candidates:
        tot = 0
        for series in D.values():
            if kind == "heatwave":
                tot += len(detect(series, 0, 0.90, fl, "ge", set(range(BASELINE[0], BASELINE[1] + 1))))
            elif kind == "coldwave":
                tot += len(detect(series, 1, 0.10, fl, "le", set(range(BASELINE[0], BASELINE[1] + 1))))
            else:
                tot += len(detect_accum(series, fl, set(range(BASELINE[0], BASELINE[1] + 1))))
        rate = per_station_year(tot, len(D), nyears)
        table.append((fl, tot, rate))
    lo, hi = TARGET_PER_STATION_YEAR
    ok = [t for t in table if lo <= t[2] <= hi]
    if ok:
        mid = (lo + hi) / 2
        best = min(ok, key=lambda t: abs(t[2] - mid))[0]
    else:
        best = min(table, key=lambda t: abs(t[2] - mid))[0]
    return best, table


# ══ 主流程 ════════════════════════════════════════════════════════════════

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sweep", action="store_true", help="打印下限扫描表")
    args = ap.parse_args()

    D = load_all()
    if not D:
        print("dataset/daily/ 为空", file=sys.stderr)
        return 2
    print(f"载入 {len(D)} 个站点\n")

    # ── 数据驱动的候选下限：从各站实际取值分布推出 ──────────────────────
    base_years = set(range(BASELINE[0], BASELINE[1] + 1))
    summer_p99, winter_p01, accum_hi = [], [], []
    for series in D.values():
        su = [v[0] for d, v in series.items() if d.year in base_years and d.month in (6, 7, 8) and v[0] is not None]
        wi = [v[1] for d, v in series.items() if d.year in base_years and d.month in (12, 1, 2) and v[1] is not None]
        ks = sorted(d for d in series if d.year in base_years and series[d][2] is not None)
        v3 = [series[ks[i]][2] + series[ks[i + 1]][2] + series[ks[i + 2]][2]
              for i in range(len(ks) - 2)
              if (ks[i + 1] - ks[i]).days == 1 and (ks[i + 2] - ks[i]).days == 2]
        if su:
            summer_p99.append(quantile(su, 0.99))
        if wi:
            winter_p01.append(quantile(wi, 0.01))
        if v3:
            accum_hi.append(quantile(v3, 0.99))

    print("=== 各站基线期气候量级（用于确定候选下限范围）===")
    print(f"  夏季 tmax P99 : {min(summer_p99):.0f} – {max(summer_p99):.0f} °C")
    print(f"  冬季 tmin P01 : {min(winter_p01):.0f} – {max(winter_p01):.0f} °C")
    print(f"  3天累计 P99   : {min(accum_hi):.0f} – {max(accum_hi):.0f} mm")
    print()

    hw_lo = int(min(summer_p99) - 6)
    hw_hi = int(max(summer_p99) + 2)
    cw_lo = int(min(winter_p01) - 6)
    cw_hi = int(max(winter_p01) + 2)
    hr_lo = int(min(accum_hi) * 0.5)
    hr_hi = int(max(accum_hi) * 1.2)

    hw_floor, hw_tab = pick_floor(D, "heatwave", list(range(hw_lo, hw_hi + 1)))
    cw_floor, cw_tab = pick_floor(D, "coldwave", list(range(cw_lo, cw_hi + 1)))
    hr_floor, hr_tab = pick_floor(D, "heavy_rain",
                                  list(range(hr_lo, hr_hi + 1, max(1, (hr_hi - hr_lo) // 24))))

    if args.sweep:
        for label, tab, unit in (("热浪 tmax 下限", hw_tab, "°C"),
                                 ("寒潮 tmin 上限", cw_tab, "°C"),
                                 ("暴雨 3天累计下限", hr_tab, "mm")):
            print(f"=== 扫描: {label} ===")
            for fl, tot, rate in tab:
                mark = "  <== 选定" if fl in (hw_floor, cw_floor, hr_floor) else ""
                print(f"   {fl:6.0f}{unit:4s} 基线 {tot:4d} 段  每站每年 {rate:.2f}{mark}")
            print()

    print("=== 选定下限（目标频率 %.1f–%.1f 次/站/年）===" % TARGET_PER_STATION_YEAR)
    print(f"  热浪  tmax >= {hw_floor:.0f} °C")
    print(f"  寒潮  tmin <= {cw_floor:.0f} °C")
    print(f"  暴雨  3天累计 >= {hr_floor:.0f} mm")
    print()

    # ── 冻结 ─────────────────────────────────────────────────────────────
    rules = {
        "version": "1.0.0",
        "structure": "window percentile (relative anomaly) + absolute floor (danger) + duration",
        "absolute_floor_is_region_specific": True,
        "calibration": (f"floor chosen so the baseline ({BASELINE[0]}–{BASELINE[1]}) yields "
                        f"{TARGET_PER_STATION_YEAR[0]}–{TARGET_PER_STATION_YEAR[1]} events per station-year"),
        "window_days": WINDOW_DAYS,
        "min_samples": MIN_SAMPLES,
        "leap_year_rule": "feb29 folds into the doy-59 window",
        "baseline_period": list(BASELINE),
        "test_period": list(TEST),
        "heatwave": {"element": "tmax_c", "window_pctl": 0.90,
                     "abs_floor": hw_floor, "min_days": 3},
        "coldwave": {"element": "tmin_c", "window_pctl": 0.10,
                     "abs_floor": cw_floor, "min_days": 3},
        "heavy_rain": {"element": "prcp_mm", "accum_days": 3,
                       "abs_floor": hr_floor, "merge_gap_days": 3},
        "sweep_tables": {
            "heatwave": [[f, t, round(r, 3)] for f, t, r in hw_tab],
            "coldwave": [[f, t, round(r, 3)] for f, t, r in cw_tab],
            "heavy_rain": [[f, t, round(r, 3)] for f, t, r in hr_tab],
        },
    }
    dest = os.path.join(DATASET, "event_rules.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(rules, f, ensure_ascii=False, indent=2)
    print(f"已写入 {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
