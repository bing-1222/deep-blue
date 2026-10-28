#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_dataset.py — 从 DWD 开放数据生成研究数据集

用法:
    python build_dataset.py                    # 增量（已有缓存就复用）
    python build_dataset.py --refresh          # 强制重新下载

产出:
    dataset/manifest.json          站点清单 + 完整度 + sha256 + 可复现的选取规则
    dataset/daily/<站号>.csv       统一契约的日值表

无需账号、无需 API key。上游: opendata.dwd.de
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import re
import sys
import urllib.request
import zipfile

# ── 路径：全部相对本文件，便于整包搬迁 ────────────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
DATASET = os.path.join(PKG, "dataset")
DAILY = os.path.join(DATASET, "daily")
CACHE = os.path.join(PKG, "cache", "dwd")

# ── 上游 ──────────────────────────────────────────────────────────────────
DWD_ROOT = ("https://opendata.dwd.de/climate_environment/CDC/"
            "observations_germany/climate/daily/kl/")
STATION_LIST = DWD_ROOT + "historical/KL_Tageswerte_Beschreibung_Stationen.txt"
UA = {"User-Agent": "deepblue-weatherlab/1.0 (research)"}

# ── 研究区域：由规则确定站点集合，不手挑 ──────────────────────────────────
REGION = {
    "id": "harz",
    "name": "Harz and foreland, Germany",
    "name_cn": "德国哈茨山及前麓",
    "box": {"lat_min": 51.0, "lat_max": 52.0, "lon_min": 10.0, "lon_max": 12.0},
}
MIN_COMPLETENESS = 98.0          # %，2000–2024 核心要素同日存在率
COMPLETENESS_YEARS = (2000, 2024)
STORE_YEARS = (2000, 2025)

# DWD kl 日值：TXK/TNK 已是摄氏度，RSK 已是毫米。缺失为 -999。
MISSING = -998.0

CONTRACT_COLUMNS = [
    "station_id", "date", "year", "month", "day", "doy",
    "tmax_c", "tmin_c", "prcp_mm", "qc_flag",
    "interpolated", "complete_core", "source", "source_version",
]


# ══ 工具函数 ══════════════════════════════════════════════════════════════

def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def http_get(url: str, timeout: int = 180) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def expected_days(year: int) -> int:
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    return 366 if leap else 365


# ══ 适配器: dwd-opendata ══════════════════════════════════════════════════

def fetch_station_list() -> list[dict]:
    """解析 DWD 官方站表。字段: id, 起止日期, 海拔, 经纬度, 站名, 州。"""
    text = http_get(STATION_LIST).decode("latin-1")
    out = []
    pat = re.compile(
        r"\s*(\d{5})\s+(\d{8})\s+(\d{8})\s+(-?\d+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(.+?)\s{2,}(\S+)\s*$")
    for line in text.splitlines():
        m = pat.match(line)
        if not m:
            continue
        sid, d0, d1, elev, lat, lon, name, state = m.groups()
        out.append({
            "station_id": sid,
            "date_from": d0, "date_to": d1,
            "elev_m": int(elev), "lat": float(lat), "lon": float(lon),
            "name": name.strip(), "state": state.strip(),
        })
    return out


def fetch_file_index() -> dict[str, str]:
    """列出 historical/ 下可下载的站文件。"""
    html = http_get(DWD_ROOT + "historical/").decode("latin-1")
    idx = {}
    for href in re.findall(r'href="([^"?][^"]*)"', html):
        m = re.match(r"tageswerte_KL_(\d{5})_(\d{8})_(\d{8})_hist\.zip", href)
        if m:
            idx[m.group(1)] = href
    return idx


def download_station(station_id: str, filename: str, refresh: bool) -> str:
    """下载并缓存单站 zip，返回本地路径。"""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{station_id}.zip")
    if refresh or not os.path.exists(path) or os.path.getsize(path) < 1000:
        blob = http_get(DWD_ROOT + "historical/" + filename)
        tmp = path + ".part"
        with open(tmp, "wb") as f:
            f.write(blob)
        os.replace(tmp, path)
    return path


def parse_station(zip_path: str) -> dict[dt.date, dict]:
    """把 DWD zip 解成 {date: 各要素}。单位在本函数内换算完毕。"""
    with zipfile.ZipFile(zip_path) as zf:
        names = [n for n in zf.namelist() if n.startswith("produkt_klima_tag")]
        if not names:
            raise ValueError(f"no produkt_klima_tag in {zip_path}")
        raw = zf.read(names[0]).decode("latin-1")

    rows = [r for r in raw.splitlines() if r.strip()]
    if len(rows) < 2:
        return {}
    header = [c.strip() for c in rows[0].split(";")]
    need = ("MESS_DATUM", "TXK", "TNK", "RSK")
    if not all(k in header for k in need):
        raise ValueError(f"missing required columns in {zip_path}: {header}")
    ix = {k: header.index(k) for k in header if k}
    ncol = len(header)

    def value(fields: list[str], key: str):
        if key not in ix:
            return None
        try:
            x = float(fields[ix[key]].strip())
        except (ValueError, IndexError):
            return None
        return None if x <= MISSING else x

    out: dict[dt.date, dict] = {}
    for line in rows[1:]:
        fields = line.split(";")
        if len(fields) < ncol:
            continue
        ds = fields[ix["MESS_DATUM"]].strip()
        if len(ds) != 8 or not ds.isdigit():
            continue
        try:
            day = dt.date(int(ds[:4]), int(ds[4:6]), int(ds[6:8]))
        except ValueError:
            continue
        qn = value(fields, "QN_4")
        out[day] = {
            "tmax_c": value(fields, "TXK"),
            "tmin_c": value(fields, "TNK"),
            "prcp_mm": value(fields, "RSK"),
            "qc_flag": "" if qn is None else str(int(qn)),
        }
    return out


def zone_of(elev_m: int) -> str:
    if elev_m >= 500:
        return "mountain"
    if elev_m >= 250:
        return "uplands"
    return "lowland"


# ══ 主流程 ════════════════════════════════════════════════════════════════

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="忽略缓存，强制重新下载")
    args = ap.parse_args()

    os.makedirs(DAILY, exist_ok=True)
    box = REGION["box"]

    print("读取 DWD 官方站表 ...")
    stations = fetch_station_list()
    print(f"  共 {len(stations)} 站")

    print("列出可下载文件 ...")
    index = fetch_file_index()
    print(f"  共 {len(index)} 个站文件")

    selected = []
    for st in stations:
        if not (box["lat_min"] <= st["lat"] <= box["lat_max"]
                and box["lon_min"] <= st["lon"] <= box["lon_max"]):
            continue
        if st["station_id"] not in index:
            continue
        if int(st["date_from"][:4]) > COMPLETENESS_YEARS[0]:
            continue
        if int(st["date_to"][:4]) < COMPLETENESS_YEARS[1]:
            continue
        selected.append(st)
    print(f"区域内且年份覆盖达标的候选站: {len(selected)}")

    kept, skipped = [], []
    y0, y1 = STORE_YEARS
    yc0, yc1 = COMPLETENESS_YEARS

    for st in selected:
        zip_path = download_station(st["station_id"], index[st["station_id"]], args.refresh)
        series = parse_station(zip_path)

        core_days = sum(
            1 for d, v in series.items()
            if yc0 <= d.year <= yc1 and v["tmax_c"] is not None and v["prcp_mm"] is not None)
        expected = sum(expected_days(y) for y in range(yc0, yc1 + 1))
        pct = 100.0 * core_days / expected
        if pct < MIN_COMPLETENESS:
            skipped.append((st, pct))
            continue

        rows, per_year = [], {}
        for d in sorted(series):
            if not (y0 <= d.year <= y1):
                continue
            v = series[d]
            complete = v["tmax_c"] is not None and v["prcp_mm"] is not None
            if complete:
                per_year[d.year] = per_year.get(d.year, 0) + 1
            rows.append({
                "station_id": st["station_id"],
                "date": d.isoformat(),
                "year": d.year, "month": d.month, "day": d.day,
                "doy": d.timetuple().tm_yday,
                "tmax_c": "" if v["tmax_c"] is None else round(v["tmax_c"], 1),
                "tmin_c": "" if v["tmin_c"] is None else round(v["tmin_c"], 1),
                "prcp_mm": "" if v["prcp_mm"] is None else round(v["prcp_mm"], 1),
                "qc_flag": v["qc_flag"],
                "interpolated": "false",
                "complete_core": "true" if complete else "false",
                "source": "dwd-opendata",
                "source_version": "DWD CDC daily kl (historical)",
            })
        if not rows:
            skipped.append((st, 0.0))
            continue

        dest = os.path.join(DAILY, st["station_id"] + ".csv")
        with open(dest, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=CONTRACT_COLUMNS)
            w.writeheader()
            w.writerows(rows)

        kept.append({
            "station_id": st["station_id"],
            "name": st["name"], "state": st["state"],
            "lat": st["lat"], "lon": st["lon"], "elev_m": st["elev_m"],
            "zone": zone_of(st["elev_m"]),
            "date_first": rows[0]["date"], "date_last": rows[-1]["date"],
            "days_core_both": core_days,
            "expected_days": expected,
            "completeness_pct": round(pct, 2),
            "per_year_core": {str(y): per_year.get(y, 0) for y in range(y0, y1 + 1)},
            "raw_sha256": sha256_file(zip_path),
            "raw_bytes": os.path.getsize(zip_path),
            "elements": {"tmax": "TXK", "tmin": "TNK", "prcp": "RSK", "qc": "QN_4"},
        })
        print(f"  [收录] {st['station_id']} {st['name'][:30]:32s} {st['elev_m']:4d}m "
              f"{zone_of(st['elev_m']):9s} {pct:5.1f}%")

    for st, pct in skipped:
        print(f"  [跳过] {st['station_id']} {st['name'][:30]:32s} {st['elev_m']:4d}m "
              f"{pct:5.1f}%  (低于 {MIN_COMPLETENESS}%)")

    kept.sort(key=lambda s: -s["elev_m"])
    if not kept:
        print("错误：没有选出任何站点", file=sys.stderr)
        return 2

    manifest = {
        "dataset": "deepblue-harz-daily",
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "adapter": "dwd-opendata",
        "regions": [{
            "id": REGION["id"],
            "name": REGION["name"],
            "role": "primary",
            "box": box,
            "station_selection_rule":
                f"inside box AND completeness_pct({COMPLETENESS_YEARS[0]}-{COMPLETENESS_YEARS[1]}) "
                f">= {MIN_COMPLETENESS}",
            "period": {"baseline": [2000, 2012], "test": [2020, 2025],
                       "stored": [y0, y1]},
            "core_variables": ["tmax_c", "prcp_mm"],
            "optional_variables": ["tmin_c"],
        }],
        "upstream": {
            "provider": "Deutscher Wetterdienst (DWD), Climate Data Center",
            "product": "Daily climate observations, station data (kl), historical",
            "base_url": DWD_ROOT + "historical/",
            "station_list": STATION_LIST,
            "login_required": False,
            "license": "DWD open data, free to use and redistribute",
        },
        "units": {"tmax_c": "degC", "tmin_c": "degC", "prcp_mm": "mm"},
        "missing_marker_upstream": "-999 (converted to empty on parse)",
        "columns": {
            "station_id": "DWD Stations_id (5 digits)",
            "date": "YYYY-MM-DD, local calendar day",
            "doy": "day of year 1..366",
            "tmax_c": "daily maximum temperature, degC (DWD TXK)",
            "tmin_c": "daily minimum temperature, degC (DWD TNK)",
            "prcp_mm": "daily precipitation total, mm (DWD RSK)",
            "qc_flag": "DWD QN_4 quality level; empty = not present",
            "interpolated": "true if the value was interpolated rather than observed",
            "complete_core": "true if BOTH tmax_c and prcp_mm exist",
        },
        "stations": kept,
    }
    out = os.path.join(DATASET, "manifest.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    zones: dict[str, int] = {}
    for s in kept:
        zones[s["zone"]] = zones.get(s["zone"], 0) + 1
    elevs = [s["elev_m"] for s in kept]
    print(f"\n站点 {len(kept)} 个 | 海拔 {min(elevs)}–{max(elevs)} m | 分区 {zones}")
    print(f"已写入 {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
