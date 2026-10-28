# DeepBlue

[English](README.md) | [中文](README.zh-CN.md)

**A weather extreme-event detection plugin for the Agnes agent, running on AGH (Agnes Harness).**

DeepBlue turns the full research loop *read station data → compute baseline thresholds → detect extreme events → back-test against independent truth → generate a report* into **six native AGH tools**, which the agent (ReAct loop, `agnes-3.0-flash`) plans, calls and reflects on by itself — end to end, on a fully open, login-free, reproducible dataset.

- **Competition**: 2026 Jiangsu AI + Science & Engineering Innovation Practice Hackathon (University Track), Main Track B · Direction B4 "Research Agent & Harness Engineering"
- **Team**: Mengfan Zhu (data & algorithms) · Ruiyang Li (AGH integration & engineering) · Bingbing Wang (acceptance testing & delivery)
- **License**: MIT

---

## 1. Project Overview

### 1.1 Background

Detecting extreme weather (heatwaves, cold waves, rainstorms) normally requires a human to chain several steps by hand:

1. Fetch and understand professional meteorological data formats;
2. Compute sensible per-station thresholds from the station's own history;
3. Run sliding-window detection, compare against independent ground truth, write a report.

This is slow, error-prone, and two people rarely get the same answer. DeepBlue sinks the whole loop into a toolchain an agent drives itself, while keeping **data public, criteria calibratable, results auditable**.

### 1.2 Core Features

| # | Tool | Role | Measured cost |
|---|---|---|---|
| 1 | `wx_ingest` | Data health check: completeness, gaps, magnitude assertions | 503 ms |
| 2 | `wx_clean` | Missing-value distribution & interpolation flagging (**flag only, never impute**) | 430 ms |
| 3 | `wx_thresholds` | Baseline-period threshold computation | 950 ms |
| 4 | `wx_detect` | Extreme-event detection over the test period | 1.0 s |
| 5 | `wx_backtest` | Compare with independent truth — hit rate / false-alarm / F1 | 1.1 s |
| 6 | `wx_report` | Full report generation | 1.2 s |

Three event types are detected with a **three-part criterion** (window quantile → absolute floor → duration), where the absolute floors are *calibrated from the regional data*, not hard-coded constants:

| Event | Criterion | Duration |
|---|---|---|
| Heatwave | `tmax ≥ P90(day-of-year ±15d window)` **and** `tmax ≥ 29 °C` | ≥ 3 consecutive days |
| Cold wave | `tmin ≤ P10(day-of-year ±15d window)` **and** `tmin ≤ −13 °C` | ≥ 3 consecutive days |
| Heavy rain | 3-day accumulated precipitation `≥ 57 mm` | adjacent hits merged |

**Dataset**: DWD (German Weather Service / Climate Data Center) open daily station data — directory listing, **no account, no application, no real-name check**. 12 stations in the Harz mountains and foothills (51–52°N, 10–12°E), elevation 85–614 m, 2000-01-01 – 2025-12-31, station completeness 98.1%–100%. Stations are selected by a reproducible rule (within region AND ≥98% completeness of simultaneous tmax+prcp over 2000–2024), not hand-picked.

### 1.3 Key Results (test period 2020–2025)

| Metric | Value |
|---|---|
| Heatwaves detected | **81** |
| Cold waves detected | **20** |
| Heavy-rain episodes detected | **55** |
| Hit rate vs independent truth | **65.8%** |
| False-alarm rate | **18.5%** |
| F1 | **0.728** |
| Physical consistency checks (`tmax ≥ tmin`, `tmin ≤ tavg ≤ tmax`, …) | **0 violations** over ~114k station-days; 197 PASS / 1 WARN / 0 FAIL |

Known historical events are reproduced by the frozen criteria — e.g. the 2012-02-06 cold wave and the 2018-08-09 heatwave hit **12/12 stations**. Partial hits (e.g. 6/12) are kept honestly: they match the distance of each event's core from the Harz region, rather than loosening criteria until everything "hits".

### 1.4 Innovation Highlights

1. **Data-calibrated criteria, not gut constants** — three-part structure + frequency sweep; the sweep table is frozen in `dataset/event_rules.json` and re-checkable via `tools/calibrate_criteria.py --sweep`.
2. **Data / processing fully decoupled** — an adapter layer normalizes any source into one contract; the six tools contain **zero source-region branches**. Swapping data sources means editing one `manifest.json`, tool code untouched.
3. **End-to-end autonomous research by the agent** — from reading data to writing the report, the ReAct loop drives the chain; the human only verifies.
4. **Fully reproducible** — login-free public data, idempotent build scripts, run evidence and calibration tables shipped in the repo.
5. **Honest reporting of physical boundaries** — high-mountain stations (600 m+) virtually never reach 30 °C, so their heatwave F1 is 0 by physics; this is documented, not hidden.

---

## 2. Demo Video

> _(To be inserted on GitHub: after the first push, open this file on github.com and drag `演示视频.mp4` into this section — GitHub hosts it and renders an inline player.)_

Evidence shipped in-repo without any upload:

- `evidence/session-export.html` — exported end-to-end agent session of the six-tool chain
- `evidence/1-ingest.out … 6-report.out` — per-tool run logs
- `evidence/session-transcript.txt` — full agent transcript

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Agnes agent (agnes-3.0-flash, ReAct loop)                  │
│  plan → call tool → observe → reflect → continue           │
└──────────────┬─────────────────────────────────────────────┘
               │ AGH extension API (tool registration / scheduling / audit)
┌──────────────▼─────────────────────────────────────────────┐
│  weatherlab-panel plugin (AGH front-end plugin)            │
│   wx_ingest · wx_clean · wx_thresholds · wx_detect ·        │
│   wx_backtest · wx_report                                    │
└──────────────┬─────────────────────────────────────────────┘
               │ Unified data contract (station_id/date/tmax_c/...)
┌──────────────▼─────────────────────────────────────────────┐
│  Data adapter layer (DWD open data → normalized contract)  │
│  Dataset: 12 Harz-region stations, 2000–2025                │
└─────────────────────────────────────────────────────────────┘
```

**Core design**: fetching (adapter) and processing (six tools) are split completely. Tools read only the unified contract, so the code contains no branch on data source or region. Add a source → write an adapter that emits the contract → register it in `manifest.json` → done.

Key modules:

- `panel/extensions/main/tools/*.mjs` — the six tools, pure functions over the contract
- `panel/extensions/main/core.mjs` · `metrics.mjs` — threshold math, sliding-window detection, backtest metrics
- `panel/extensions/main/index.mjs` — AGH backend entry; `agnes.client.json` declares slots/styles/config; `client/index.js` is the zero-build front-end panel (edit the `CONFIG` block at its top, refresh the page)
- `tools/*.py` — offline pipeline: `build_dataset.py` (download DWD → generate `dataset/`, sha256 frozen), `check_quality.py` (hard quality gates), `calibrate_criteria.py`, `validate_criteria.py` (known-event reproduction)

---

## 4. Integration Standards

### 4.1 Plugin packaging (AGH)

The plugin ships as a standard AGH panel package; no build step for the front-end:

```bash
agh package inspect file:./deepblue/panel
agh install file:./deepblue/panel
agh package trust weatherlab-panel <integrity> <capabilityHash>
agh package enable weatherlab-panel
agh package status
```

The dataset is located in this order: env `AURORA_DATA_ROOT` / `WX_DATA_ROOT` → inside the plugin package → one level above the package → current working directory. Tools also accept an explicit `dataRoot` parameter.

### 4.2 Unified data contract

This is the adapter's output and the **only** input the six tools read:

| Field | Meaning |
|---|---|
| `station_id` | station identifier (string) |
| `date` | `YYYY-MM-DD` |
| `year` `month` `day` `doy` | split fields; `doy` = day-of-year 1–366 |
| `tmax_c` | daily max temperature, °C |
| `tmin_c` | daily min temperature, °C |
| `prcp_mm` | daily precipitation total, mm |
| `qc_flag` | upstream quality-control flag |
| `interpolated` | whether the value was imputed |
| `complete_core` | whether core variables are present for the day |
| `source` `source_version` | provenance (traceable) |

**Downstream tools must never read upstream raw-format fields.** This rule is the precondition for the swap-source capability.

### 4.3 Integration rules

- Cleaning strategy is **flag-only**: imputation fabricates extreme events, so missing data is flagged and never auto-filled.
- Every tool returns a uniform envelope validated against a schema; both the agent and a human can re-check.
- All calls are audited at `$AGH_HOME/data/audit/host.jsonl` (params + results per call).
- To add a new data source, follow `tools/data-source-adapter.md`: implement the adapter → emit the contract → register in `dataset/manifest.json` with a sha256; no tool code changes.

---

## 5. Quick Start

> **Linux only** for the AGH integration part (verified on Ubuntu 22.04 + Node 24.16). Windows users: use **WSL**.

```bash
bash setup.sh        # toolchain + Node 24 + pnpm (idempotent)
bash bootstrap.sh    # build AGH from source + install & enable this plugin (idempotent)

# Reproduce the dataset (no credentials needed; needs access to opendata.dwd.de)
python3 tools/build_dataset.py
python3 tools/check_quality.py       # expect FAIL=0
python3 tools/calibrate_criteria.py
python3 tools/validate_criteria.py

# Plugin self-tests without AGH
cd panel
node selftest.mjs
node selftest-tools.mjs

# Run the web UI
bash start-web.sh    # http://127.0.0.1:4177/
```

## 6. Repository Layout

```
DeepBlue/
├── README.md / README.zh-CN.md
├── panel/                  AGH front-end plugin (zero build)
│   ├── package.json         AGH plugin manifest
│   ├── extensions/main/      backend entry, client declaration, tools/, core/metrics
│   └── selftest*.mjs
├── tools/                   offline Python pipeline + data-source adapter doc
├── dataset/                 12 stations × daily CSVs, manifest.json, frozen event_rules.json
└── evidence/                exported session, per-tool logs, transcript
```

## 7. License

[MIT](LICENSE) © 2026 DeepBlue Team. DWD open data may be freely used and redistributed; this project contains no personal information.
