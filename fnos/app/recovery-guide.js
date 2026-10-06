'use strict';
// 只分类和建议，不执行修复、不改配置。未知错误保持未知。
function classifyFailure(error) {
  const text = String(error || '');
  if (/ADAPTER_|CORE_RUNTIME_INVALID|CORE_SELECTION_VERSION_MISMATCH|Unsupported core adapter/.test(text)) return { kind: 'core-adapter', infrastructure: true, title: /ADAPTER_VERSION_MISMATCH/.test(text) ? '核心与适配声明版本不一致' : '核心适配声明校验失败', advice: '查看错误中的实际核心版本、声明版本和文件位置；只读重新检查配套关系。不要自动降级核心、只改声明版本号或恢复业务数据；配套检查通过后再重试启动。' };
  if (/ENOENT/.test(text) && /\/opt\/dsh\/home/.test(text)) return {
    kind: /\/sessions\//.test(text) ? 'session-path' : 'home-path', infrastructure: true,
    title: /\/sessions\//.test(text) ? '会话读取路径不可用' : 'DSH 数据路径不可用',
    advice: /\/sessions\//.test(text)
      ? '先核对桥接目标、会话文件和失败堆栈。不要新建空会话文件、删除锁或强制退回旧格式。'
      : '先核对 /opt/dsh/home 是否为可达且指向本应用数据目录的链接；保留错误现场。修复路径后再重试，禁用插件或重置 patch 不能修复路径缺失。',
  };
  if (/EACCES|EPERM|permission denied/i.test(text)) return { kind: 'permissions', infrastructure: true, title: '文件权限或授权故障', advice: '核对报错路径、应用身份及 fnOS 授权。不要递归放宽目录权限；配置重置不能修复系统 ACL。' };
  if (/EADDRINUSE|端口被占用/.test(text)) return { kind: 'port', infrastructure: true, title: '端口冲突', advice: '查看端口设置及监听者身份，只回收确认属于本应用的残留；不要结束其他应用或盲目禁用插件。' };
  if (/duplicate loader entry|插件加载项重复/.test(text)) return { kind: 'duplicate', infrastructure: false, title: '插件声明重复', advice: '先查看重复的条目与备份，再清理重复声明；不要直接重置整个配置。' };
  if (/must be a top-level YAML array|failed to parse overlay|must be a mapping|不是 mapping|YAML 语法错误/.test(text)) return { kind: 'patch', infrastructure: false, title: 'patch 配置格式损坏', advice: '先导出现场并校验备份。优先恢复可用配置，重置会丢失自定义条目，仅作为最后手段。' };
  if (/Cannot find package|cannot resolve profile bundle|缺少依赖/.test(text)) return { kind: 'dependency', infrastructure: false, title: '插件依赖缺失', advice: '先检查装载清单、模块解析和安装日志，再决定是否修复文件；不要跳过包校验或擅自改依赖版本。' };
  return { kind: 'unknown', infrastructure: false, title: '启动故障尚未定案', advice: '先查看核心最后输出与诊断包，确认根因后再逐步尝试可逆修复；未复现不等于已解决。' };
}
module.exports = { classifyFailure };
