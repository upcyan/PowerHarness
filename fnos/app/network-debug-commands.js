const plugins = require('./plugins.js');

const simpleActions = new Set(['check-update', 'retry', 'backup', 'safe-mode']);
const pluginActions = new Set(['disable-plugin', 'enable-plugin']);
const probePathPattern = /^\/dsh-[a-z0-9-]{1,63}\/(?:ping|summary)$/;

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('指令必须是 JSON 对象');
  const { action } = input;
  if (typeof action !== 'string') throw new Error('缺少指令名称');
  if (simpleActions.has(action)) {
    if (Object.keys(input).length !== 1) throw new Error('该指令不接受参数');
    return { action, params: {} };
  }
  if (pluginActions.has(action)) {
    if (Object.keys(input).length !== 2 || typeof input.packageName !== 'string') throw new Error('仅接受已安装插件包名');
    const parsed = plugins.parseSpec(input.packageName);
    if (parsed.requestedVersion || parsed.name !== input.packageName) throw new Error('仅接受已安装插件包名');
    return { action, params: { packageName: parsed.name } };
  }
  if (action === 'probe-plugin-route') {
    if (Object.keys(input).length !== 2 || typeof input.path !== 'string' || !probePathPattern.test(input.path)) throw new Error('仅可探测插件的 /ping 或 /summary 路径');
    return { action, path: input.path };
  }
  throw new Error('指令不在临时调试白名单中');
}

module.exports = { validate, simpleActions, pluginActions };
