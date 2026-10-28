// ============================================================================
//  后端插件入口：注册六个 wx_* 工具 + 面板所需的查询服务
// ============================================================================
//  这个模块是 Cordis 对象插件。AGH 通过 ctx.extension() 交出该行的
//  tool / hook / event API；通过 ctx.services.register() 注册同包服务。
//
//  两个坑（都踩过）：
//    1. 日志必须走 agnes.ctx.log，不能写 ctx.log —— 外层插件 Context 是白名单代理，
//       未 inject 的属性访问会抛 "cannot get property \"log\" without inject"，
//       而且这个异常发生在 apply() 里，会让整个插件行 load 失败（E_EXT_LOAD）。
//       因此这里连日志都包了 try/catch，宁可少一行日志也不能让插件起不来。
//    2. 服务名必须同时出现在 agnes.client.json 的 client.services 数组里，
//       否则浏览器侧的 ctx.agnes.services.call() 会被 fail-closed 拒绝。
// ============================================================================
import { tools } from './tools/index.mjs'
import { computeMetrics } from './metrics.mjs'

const SERVICE = 'weatherlab.panel.metrics'

/** 安全日志：任何异常都吞掉，绝不影响插件加载 */
function safeLog(agnes, ctx, level, message) {
  for (const target of [agnes?.ctx, ctx]) {
    try {
      const fn = target?.['log']?.[level]
      if (typeof fn === 'function') { fn.call(target['log'], message); return }
    } catch {
      // 属性访问被白名单拒绝，换下一个目标
    }
  }
}

export const weatherTools = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()

    // ── 1. 六个工具 ────────────────────────────────────────────────────────
    for (const tool of tools) {
      agnes.registerTool(tool)
    }

    // ── 2. 面板查询服务 ────────────────────────────────────────────────────
    // 服务注册失败不应该让六个工具一起失效，所以单独兜住异常：
    // 面板会显示 services 不可用，但工具仍然可用。
    let serviceOk = false
    try {
      // kind:'query' + 输出 schema 只声明稳定字段，其余用 additionalProperties:true
      // 放行（面板字段会随迭代增加，不应每次改 schema）。
      ctx.services.register({
        name: SERVICE,
        kind: 'query',
        inputSchema: {
          type: 'object',
          properties: {
            dataRoot: { type: 'string' },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            generatedAt: { type: 'string' },
            cached: { type: 'boolean' },
          },
          required: ['ok'],
          additionalProperties: true,
        },
        // 首次计算要扫 12 站 × 9.5 千行（实测 ~1.2 s），之后走缓存；
        // 留 30 s 是为冷启动 + 慢磁盘留足余量。
        timeoutMs: 30000,
        maxResultBytes: 262144,
        async handler(input) {
          // 任何异常都转成结构化错误：面板要能显示「不可用」，而不是把会话弄崩
          try {
            return await computeMetrics(input?.dataRoot)
          } catch (error) {
            return {
              ok: false,
              generatedAt: new Date().toISOString(),
              error: String(error?.message ?? error).slice(0, 400),
            }
          }
        },
      })
      serviceOk = true
    } catch (error) {
      safeLog(agnes, ctx, 'warn',
        `WeatherLab: 服务 ${SERVICE} 注册失败（工具仍可用）: ${String(error?.message ?? error)}`)
    }

    safeLog(agnes, ctx, 'info',
      `WeatherLab: 已注册 ${tools.length} 个工具 (${tools.map((t) => t.name).join(', ')})` +
      `；服务 ${SERVICE} ${serviceOk ? '就绪' : '不可用'}`)
  },
}

export const main = weatherTools
