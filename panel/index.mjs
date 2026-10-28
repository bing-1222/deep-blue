// 后端入口。
//
// 这个文件只做一件事：把六个 wx_* 工具所组成的插件对象暴露给 AGH。
// 导出名必须与 package.json 里 agnes.plugins[].export 完全一致（这里是 weatherTools），
// 否则 AGH 会以 "package plugin module cannot be loaded" 拒绝启用。
//
// 真正的实现分两层：
//   extensions/main/index.mjs  注册工具（Cordis 插件）
//   extensions/main/core.mjs   纯函数核心库（阈值、事件检测）
//
// 界面代码在 extensions/main/client/index.js，由浏览器加载，与后端互不影响。
export { weatherTools, main } from './extensions/main/index.mjs'
