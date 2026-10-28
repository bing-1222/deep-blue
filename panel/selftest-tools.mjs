// 六工具测试台：脱离 AGH 直接调用，验证每个工具都能正常产出。
// 同时用一个最小假的 ctx 模拟 AGH 的 ToolContext（只用到 log 与 signal）。
import { tools } from './extensions/main/tools/index.mjs'

const fakeCtx = {
  log: { info: () => {}, warn: () => {}, error: () => {} },
  signal: new AbortController().signal,
  progress: () => {},
  cwd: process.cwd(),
}

const NAMES = ['wx_ingest', 'wx_clean', 'wx_thresholds', 'wx_detect', 'wx_backtest', 'wx_report']
let failed = 0

// ── 结构校验：与 AGH 的 checkToolDef 同规则 ──
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const META_KEYS = ['isReadOnly', 'isDestructive', 'isConcurrencySafe', 'isOpenWorld',
                   'replay', 'costHint', 'deferLoading', 'requiresApproval']
const Kind = Symbol.for('TypeBox.Kind')

function checkDef(def) {
  const p = []
  if (typeof def.name !== 'string' || !TOOL_NAME.test(def.name)) p.push('name 不合法')
  if (typeof def.description !== 'string' || !def.description.length) p.push('description 缺失')
  if (def.description.length > 4096) p.push('description 超长')
  if (!def.parameters || typeof def.parameters !== 'object') p.push('parameters 缺失')
  else if (def.parameters[Kind] !== 'Object') p.push('parameters 缺少 TypeBox Object 标记')
  if (typeof def.execute !== 'function') p.push('execute 缺失')
  for (const k of META_KEYS) if (!Object.hasOwn(def.meta, k)) p.push(`meta.${k} 缺失`)
  if (def.classify !== undefined && typeof def.policyVersion !== 'string') p.push('有 classify 但缺 policyVersion')
  if (def.classify === undefined && def.policyVersion !== undefined) p.push('无 classify 却有 policyVersion')
  return p
}

console.log('=== 1. 工具定义结构校验（按 AGH checkToolDef 规则）===')
for (const n of NAMES) {
  const def = tools.find((t) => t.name === n)
  if (!def) { console.log(`  ${n.padEnd(16)} **未注册**`); failed++; continue }
  const problems = checkDef(def)
  console.log(`  ${n.padEnd(16)} ${problems.length ? '**' + problems.join('; ') + '**' : 'OK'}`)
  if (problems.length) failed++
}
console.log()

// ── 逐个调用 ──
const CASES = [
  ['wx_ingest', {}],
  ['wx_clean', { listSuspect: 3 }],
  ['wx_thresholds', {}],
  ['wx_detect', { listEvents: true }],
  ['wx_backtest', {}],
  ['wx_report', { maxFirstErrors: 3 }],
]

console.log('=== 2. 逐个调用 ===')
for (const [name, args] of CASES) {
  const def = tools.find((t) => t.name === name)
  if (!def) continue
  const t0 = Date.now()
  try {
    const res = await def.execute(args, fakeCtx)
    const ms = Date.now() - t0
    const text = res.content?.[0]?.text ?? ''
    const okStruct = res.structured !== undefined
    console.log(`\n──── ${name}  (${ms}ms, ${text.length} 字符, structured=${okStruct ? 'Y' : 'N'}) ────`)
    console.log(text.split('\n').slice(0, 22).join('\n'))
    if (text.split('\n').length > 22) console.log(`... (共 ${text.split('\n').length} 行)`)
    if (res.isError) { console.log('  ** isError=true **'); failed++ }
  } catch (e) {
    console.log(`\n──── ${name}  **抛出异常** ────`)
    console.log('  ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n  ') : String(e)))
    failed++
  }
}

console.log('\n' + (failed ? `**${failed} 项失败**` : 'TOOLS-SELFTEST PASS：六工具全部正常'))
process.exit(failed ? 1 : 0)
