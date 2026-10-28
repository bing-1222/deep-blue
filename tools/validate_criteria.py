#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
validate_criteria.py — 判据对已知历史事件的复现检验

用法:
    python validate_criteria.py

这是唯一能证明「判据不是空转」的方法：
挑有公开记录的历史极端事件，检查判据能否在正确日期检出。

原则：如果检不出，先确认数据本身对不对，不要为了「能检出」而调松判据。
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
DATASET = os.path.join(PKG, "dataset")
DAILY = os.path.join(DATASET, "daily")

# 有公开记录的历史极端事件（日期为事件核心日，用于检查是否落在检出区间内）
KNOWN_EVENTS = [
    ("寒潮", dt.date(2012, 2, 6),  "2012 年欧洲寒潮（Europe cold wave）"),
    ("寒潮", dt.date(2009, 12, 19), "2009 年 12 月欧洲寒潮"),
    ("寒潮", dt.date(2021, 2, 14),  "2021 年 2 月欧洲寒潮"),
    ("寒潮", dt.date(2018, 2, 28),  "2018 年 2-3 月欧洲寒潮（Beast from the East）"),
    ("热浪", dt.date(2019, 7, 25),  "2019 年 7 月欧洲热浪"),
    ("热浪", dt.date(2018, 8, 9),   "2018 年欧洲热浪"),
    ("热浪", dt.date(2015, 8, 7),   "2015 年德国热浪"),
    ("热浪", dt.date(2022, 7, 20),  "2022 年欧洲热浪"),
]

ALL_YEARS = set(range(2000, 2026))


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
    return 59 if (d.month == 2 and d.day == 29) else d.timetuple().tm_yday


def quantile(values, p):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, max(0, int(round(p * (len(s) - 1)))))]


def window_thresholds(series, idx, pctl, years, window_days):
    buckets = {}
    for d, v in series.items():
        if d.year in years and v[idx] is not None:
            buckets.setdefault(doy_key(d), []).append(v[idx])
    thr = {}
    for k in range(1, 367):
        vals = []
        for off in range(-window_days, window_days + 1):
            kk = k + off
            if kk < 1:
                kk += 365
            elif kk > 366:
                kk -= 366
            vals.extend(buckets.get(kk, ()))
        thr[k] = quantile(vals, pctl)
    return thr


def runs(seq, minlen):
    out, cur, prev = [], [], None
    for d, hit in seq:
        cont = prev is not None and (d - prev).days == 1
        if hit:
            cur = cur + [d] if (cont and cur) else [d]
        else:
            if len(cur) >= minlen:
                out.append((cur[0], cur[-1]))
            cur = []
        prev = d
    if len(cur) >= minlen:
        out.append((cur[0], cur[-1]))
    return out


def main() -> int:
    rules = json.load(open(os.path.join(DATASET, "event_rules.json"), encoding="utf-8"))
    D = load_all()
    if not D:
        print("dataset/daily/ 为空", file=sys.stderr)
        return 2

    base = set(range(rules["baseline_period"][0], rules["baseline_period"][1] + 1))
    wd = rules["window_days"]

    print(f"判据版本 {rules['version']}")
    print(f"  热浪 tmax >= P{rules['heatwave']['window_pctl']:.2f}(窗口) 且 >= {rules['heatwave']['abs_floor']:.0f} °C")
    print(f"  寒潮 tmin <= P{rules['coldwave']['window_pctl']:.2f}(窗口) 且 <= {rules['coldwave']['abs_floor']:.0f} °C")
    print(f"  暴雨 3 天累计 >= {rules['heavy_rain']['abs_floor']:.0f} mm")
    print(f"站点 {len(D)} 个 | 基线 {rules['baseline_period']} | 检测区间 2000–2025")
    print()

    # 预先算好每个站在全期的两类事件区间
    heat, cold = {}, {}
    for sid, series in D.items():
        thr_t = window_thresholds(series, 0, rules["heatwave"]["window_pctl"], base, wd)
        seq = []
        for d in sorted(series):
            v = series[d][0]
            if v is None:
                continue
            t = thr_t.get(doy_key(d))
            seq.append((d, t is not None and v >= t and v >= rules["heatwave"]["abs_floor"]))
        heat[sid] = runs(seq, rules["heatwave"]["min_days"])

        thr_n = window_thresholds(series, 1, rules["coldwave"]["window_pctl"], base, wd)
        seq = []
        for d in sorted(series):
            v = series[d][1]
            if v is None:
                continue
            t = thr_n.get(doy_key(d))
            seq.append((d, t is not None and v <= t and v <= rules["coldwave"]["abs_floor"]))
        cold[sid] = runs(seq, rules["coldwave"]["min_days"])

    print("=== 已知事件复现 ===")
    print(f"{'类型':<5} {'日期':<12} {'命中':<9} {'判定':<7} 事件说明")
    weak = []
    for kind, day, label in KNOWN_EVENTS:
        pool = heat if kind == "热浪" else cold
        hit = sum(1 for sid in D if any(a <= day <= b for a, b in pool[sid]))
        n = len(D)
        ratio = hit / n
        verdict = "OK" if ratio >= 0.5 else ("偏弱" if ratio > 0 else "未检出")
        if ratio < 0.5:
            weak.append((kind, day, label, hit, n))
        print(f"{kind:<5} {day.isoformat():<12} {hit:>2}/{n:<6} {verdict:<7} {label}")

    print()
    print("=== 说明 ===")
    print("  「偏弱」不一定是判据问题。事件中心若不在本区域，本区域站点自然命中少。")
    print("  例如 2022 年欧洲热浪中心偏西，哈茨山不在峰值区，命中率低是正确的。")
    print("  判定标准：寒潮/热浪类事件应有多数站点命中；个别事件偏低需能给出地理原因。")

    if weak:
        print()
        print("--- 命中偏低的事件 ---")
        for kind, day, label, hit, n in weak:
            print(f"  {kind} {day} : {hit}/{n}  {label}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
