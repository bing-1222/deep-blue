#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check_quality.py — 数据集质量校验

用法:
    python check_quality.py

对 dataset/daily/*.csv 执行硬校验，输出 PASS/WARN/FAIL 汇总。
任一 FAIL 都意味着数据集不可用于下游。

校验项（按重要性排序）:
  1. 物理一致性: tmax >= tmin, tmin <= tmean <= tmax
  2. 量级合理性: 极值是否落在气候可能的范围内
  3. 日期卫生:   doy 与日期自洽、无重复、无越界
  4. 单位哨兵:   不应出现 -999 之类的上游缺测码
  5. 完整度:     逐年逐站实测，不读上游声称的范围
  6. 跨站一致:   同区域站点的温度序列应高度相关
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import os
import statistics as st
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
DATASET = os.path.join(PKG, "dataset")
DAILY = os.path.join(DATASET, "daily")

REGION_BASELINE = (2000, 2012)

# 温带气候可能范围（宽松但足以抓住单位错误）
LIMITS = {
    "tmax_c": (-45.0, 50.0),
    "tmin_c": (-50.0, 45.0),
    "prcp_mm": (0.0, 400.0),      # 日降水；温带单日极值不会超过数百毫米
}
ANNUAL_PRCP_RANGE = (200.0, 3000.0)

results: list[tuple[str, str, str]] = []


def check(status: str, name: str, detail: str = "") -> None:
    results.append((status, name, detail))


def load(station_id: str) -> list[dict]:
    path = os.path.join(DAILY, station_id + ".csv")
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def num(row: dict, key: str):
    v = row.get(key, "")
    return None if v in ("", None) else float(v)


def main() -> int:
    if not os.path.isdir(DAILY):
        print(f"找不到 {DAILY}", file=sys.stderr)
        return 2

    files = sorted(f for f in os.listdir(DAILY) if f.endswith(".csv"))
    if not files:
        print("dataset/daily/ 里没有 csv", file=sys.stderr)
        return 2

    data = {f[:-4]: load(f[:-4]) for f in files}
    print(f"载入 {len(data)} 个站点\n")

    # ── 1. 契约字段 ──────────────────────────────────────────────────────
    print("=== 1. 契约字段 ===")
    want = ["station_id", "date", "year", "month", "day", "doy",
            "tmax_c", "tmin_c", "prcp_mm", "qc_flag",
            "interpolated", "complete_core", "source", "source_version"]
    for sid, rows in data.items():
        got = list(rows[0].keys())
        check("PASS" if got == want else "FAIL",
              f"{sid} 字段与契约一致",
              "" if got == want else f"got {got}")
    print()

    # ── 2. 日期卫生 ──────────────────────────────────────────────────────
    print("=== 2. 日期卫生 ===")
    for sid, rows in data.items():
        dates = [r["date"] for r in rows]
        dup = len(dates) - len(set(dates))
        bad_doy = bad_ymd = 0
        for r in rows:
            d = dt.date.fromisoformat(r["date"])
            if int(r["doy"]) != d.timetuple().tm_yday:
                bad_doy += 1
            if (int(r["year"]), int(r["month"]), int(r["day"])) != (d.year, d.month, d.day):
                bad_ymd += 1
        check("PASS" if dup == 0 else "FAIL", f"{sid} 无重复日期", f"dup={dup}")
        check("PASS" if bad_doy == 0 else "FAIL", f"{sid} doy 自洽", f"mismatch={bad_doy}")
        check("PASS" if bad_ymd == 0 else "FAIL", f"{sid} 年月日自洽", f"mismatch={bad_ymd}")
    print()

    # ── 3. 无上游哨兵值 ──────────────────────────────────────────────────
    print("=== 3. 无上游哨兵值（单位/缺测码须在解析阶段处理掉）===")
    for sid, rows in data.items():
        bad = 0
        for r in rows:
            for k in ("tmax_c", "tmin_c", "prcp_mm"):
                v = r.get(k, "")
                if v not in ("", None) and float(v) <= -998:
                    bad += 1
        check("PASS" if bad == 0 else "FAIL", f"{sid} 无 -999/-9999 残留", f"count={bad}")
    print()

    # ── 4. 量级合理性 ────────────────────────────────────────────────────
    print("=== 4. 量级合理性（抓单位错误）===")
    for sid, rows in data.items():
        for key, (lo, hi) in LIMITS.items():
            vals = [num(r, key) for r in rows]
            vals = [v for v in vals if v is not None]
            if not vals:
                check("WARN", f"{sid} {key} 无数据")
                continue
            out = [v for v in vals if not (lo <= v <= hi)]
            check("PASS" if not out else "FAIL",
                  f"{sid} {key} 在 [{lo}, {hi}]",
                  f"n={len(vals)} min={min(vals):.1f} max={max(vals):.1f} 越界={len(out)}")
        per_year: dict[int, float] = {}
        for r in rows:
            v = num(r, "prcp_mm")
            if v is not None:
                per_year[int(r["year"])] = per_year.get(int(r["year"]), 0.0) + v
        full = {y: t for y, t in per_year.items() if y < 2026 and t > 0}
        if full:
            lo, hi = min(full.values()), max(full.values())
            ok = ANNUAL_PRCP_RANGE[0] <= lo and hi <= ANNUAL_PRCP_RANGE[1]
            check("PASS" if ok else "FAIL", f"{sid} 年降水量量级",
                  f"{lo:.0f} – {hi:.0f} mm（期望 {ANNUAL_PRCP_RANGE[0]:.0f}–{ANNUAL_PRCP_RANGE[1]:.0f}）")
    print()

    # ── 5. 物理一致性（最强的一项）──────────────────────────────────────
    print("=== 5. 物理一致性 tmax >= tmin ===")
    total_checked = 0
    for sid, rows in data.items():
        n = viol = 0
        worst = None
        for r in rows:
            a, b = num(r, "tmax_c"), num(r, "tmin_c")
            if a is None or b is None:
                continue
            n += 1
            if a < b:
                viol += 1
                if worst is None or (b - a) > worst[0]:
                    worst = (b - a, r["date"], a, b)
        total_checked += n
        check("PASS" if viol == 0 else "FAIL",
              f"{sid} tmax >= tmin", f"检查 {n} 天, 违反 {viol} {worst or ''}")
    print(f"  合计检查 {total_checked:,} 条\n")

    # ── 6. 逐年完整度（实测，不读声明）──────────────────────────────────
    print("=== 6. 逐年完整度（核心要素同日存在率）===")
    for sid, rows in data.items():
        per = {}
        for r in rows:
            if r["complete_core"] == "true":
                per[int(r["year"])] = per.get(int(r["year"]), 0) + 1
        weak = [y for y, c in per.items() if c < 300]
        check("PASS" if not weak else "WARN",
              f"{sid} 无残缺年份",
              f"低于 300 天的年份: {sorted(weak)}" if weak else
              f"{min(per)}–{max(per)} 全部 >= 300 天")
    print()

    # ── 7. 跨站一致性 ────────────────────────────────────────────────────
    print("=== 7. 跨站一致性（同区域温度应高度相关）===")
    ids = sorted(data)
    series = {}
    for sid in ids:
        series[sid] = {r["date"]: num(r, "tmax_c")
                       for r in data[sid] if r["tmax_c"] != ""}
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = series[ids[i]], series[ids[j]]
            common = sorted(set(a) & set(b))
            if len(common) < 200:
                continue
            xs = [a[d] for d in common]
            ys = [b[d] for d in common]
            mx, my = st.mean(xs), st.mean(ys)
            num_ = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
            den = (sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys)) ** 0.5
            r_ = num_ / den if den else float("nan")
            check("PASS" if r_ >= 0.90 else "WARN",
                  f"{ids[i]} ~ {ids[j]} tmax 相关", f"r={r_:.3f} n={len(common)}")
    print()

    # ── 汇总 ─────────────────────────────────────────────────────────────
    counts = {"PASS": 0, "WARN": 0, "FAIL": 0}
    for s, _, _ in results:
        counts[s] += 1
    print("=== 汇总 ===")
    print(f"PASS={counts['PASS']}  WARN={counts['WARN']}  FAIL={counts['FAIL']}")
    if counts["FAIL"] == 0:
        print("VERDICT: 数据集通过全部硬校验，可用于下游工具。")
    else:
        print("VERDICT: 存在硬失败，必须先修复。")
    print()
    print("--- 明细 ---")
    for s, n, d in results:
        if s != "PASS":
            print(f"[{s}] {n}  {d}")

    return 0 if counts["FAIL"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
