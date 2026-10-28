// 六个 wx_* 工具的统一导出。
import { wxIngest } from './ingest.mjs'
import { wxClean } from './clean.mjs'
import { wxThresholds } from './thresholds.mjs'
import { wxDetect } from './detect.mjs'
import { wxBacktest } from './backtest.mjs'
import { wxReport } from './report.mjs'

export const tools = [wxIngest, wxClean, wxThresholds, wxDetect, wxBacktest, wxReport]
export { wxIngest, wxClean, wxThresholds, wxDetect, wxBacktest, wxReport }
