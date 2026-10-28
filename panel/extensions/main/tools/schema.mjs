// TypeBox 兼容的 schema 构造器。
// 手写 Symbol.for('TypeBox.Kind') 标记即可免去外部依赖——见 AGH 官方示例
// examples/packages/hot-tool-plugin/index.mjs。
const Kind = Symbol.for('TypeBox.Kind')

const t = (kind, extra = {}) => ({ [Kind]: kind, ...extra })

export const Type = {
  Object: (properties, opts = {}) => t('Object', { type: 'object', properties, ...opts }),
  String: (o = {}) => t('String', { type: 'string', ...o }),
  Integer: (o = {}) => t('Integer', { type: 'integer', ...o }),
  Number: (o = {}) => t('Number', { type: 'number', ...o }),
  Boolean: (o = {}) => t('Boolean', { type: 'boolean', ...o }),
  Array: (items, o = {}) => t('Array', { type: 'array', items, ...o }),
  Optional: (schema) => ({ ...schema, [Symbol.for('TypeBox.Optional')]: true }),
}

/** 工具元数据。八个键必须全部写出——缺失会被 checkToolMeta 拒绝。 */
export function meta(overrides = {}) {
  return {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: false,
    replay: 'safe',
    costHint: undefined,
    deferLoading: undefined,
    requiresApproval: 'never',
    ...overrides,
  }
}
