/** Generate data-only probes from the authoritative build patcher, never run it. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
const must = (yes, message) => { if (!yes) throw Error(message); };
const LF = String.fromCharCode(10);
export function createPlatformCatalog(patcher, polyfill) {
  must(patcher.split('fs.writeFileSync(').length-1===4,'实际平台写入种类变化，必须复核清单覆盖');
  must(!polyfill.includes('</'+'script'),'shim含script终止符，不能生成安全检查清单');
  // Evaluate only a closed string literal, not the patcher or its filesystem code.
  function stringAt(text, start) {
    while (text[start] === ' ' || text[start] === LF) start++;
    const quote=text[start]; must(quote === "'" || quote === '"', '预期字符串字面量');
    let end=start+1;
    while(end<text.length) {
      if(text.charCodeAt(end)===92){end+=2;continue;}
      if(text[end]===quote) return {value:vm.runInNewContext(text.slice(start,end+1),Object.create(null),{timeout:100}),end:end+1};
      end++;
    }
    throw Error('未闭合字符串字面量');
  }
  function constant(name,from=0) {
    const prefix='const '+name+' = ',at=patcher.indexOf(prefix,from);
    must(at>=0,'平台清单生成失败：常量 '+name);return stringAt(patcher,at+prefix.length).value;
  }
  const trustAt=patcher.indexOf('for (const connectionFile of connectionFiles)');
  const gatewayAt=patcher.indexOf("const files = clientEntry('dsh-api-gateway')");
  const composerAt=patcher.indexOf('(function patchComposerSeatBackground()');
  const shimAt=patcher.indexOf('(function patchLegacyCompat()');
  must([trustAt,gatewayAt,composerAt,shimAt].every(at=>at>=0),'平台补丁分类锚点漂移');
  const functionAt=patcher.indexOf('function installForegroundRecovery(');
  const functionEnd=patcher.indexOf(LF+'{'+LF+"  const files = clientEntry('dsh-api-gateway'",functionAt);
  must(functionAt>=0 && functionEnd>functionAt,'foreground函数边界漂移');
  const recoveryFunction=patcher.slice(functionAt,functionEnd).trim();
  function template(name) {
    const prefix='const '+name+' = '+String.fromCharCode(96),start=patcher.indexOf(prefix,gatewayAt);
    must(start>=0,'缺少模板 '+name);const body=start+prefix.length,end=patcher.indexOf(String.fromCharCode(96)+';',body);
    must(end>=body,'模板边界漂移 '+name);return patcher.slice(body,end);
  }
  const anchor=constant('anchor',gatewayAt),marker=constant('marker',gatewayAt);
  const recovery=template('recovery').split(String.fromCharCode(92)+'n').join(LF)
    .replaceAll('$'+'{anchor}',anchor).replaceAll('$'+'{marker}',marker)
    .replaceAll('$'+'{installForegroundRecovery.toString()}',recoveryFunction)
    .replaceAll('$'+'{probe}',template('probe')).replaceAll('$'+'{reconnect}',template('reconnect'));
  const blockAt=patcher.indexOf('const block = ',shimAt);must(blockAt>=0,'shim拼接表达式漂移');
  const blockExpression=patcher.slice(blockAt+'const block = '.length).split(LF)[0].trim();
  must(blockExpression.endsWith(';'),'shim拼接结束边界漂移');
  const block=vm.runInNewContext(blockExpression.slice(0,-1),{marker:constant('marker',shimAt),polyfill},{timeout:100});
  const routes=[];let routeAt=0;
  while((routeAt=patcher.indexOf("assertAnchor('",routeAt))>=0) {
    const first=stringAt(patcher,routeAt+'assertAnchor('.length);
    const second=stringAt(patcher,patcher.indexOf(',',first.end)+1);
    const third=stringAt(patcher,patcher.indexOf(',',second.end)+1);
    routes.push({id:'platform-route-'+routes.length,kind:'route',plugin:'@deepseek-ai/'+first.value,description:third.value,needle:second.value});routeAt=third.end;
  }
  must(routes.length===8,'相对路由契约数量变化，必须复核清单');
  const rules=[
    {id:'platform-core-version',kind:'version',plugin:'@deepseek-ai/dsh-client-connection',description:'核心与客户端连接模块版本一致'},
    {id:'platform-gateway-trust',kind:'replace',plugin:'@deepseek-ai/dsh-client-connection',description:'fnOS认证网关信任适配',anchor:constant('anchor',trustAt),applied:constant('applied',trustAt)},
    {id:'platform-foreground-probe',kind:'probe',plugin:'@deepseek-ai/dsh-api-gateway',description:'无副作用的前台连接探针契约',targetFile:'lib/index.js',reject:constant('rejectAnchor',gatewayAt),prefixes:[constant('validationPrefix',gatewayAt),constant('validationPrefix020',gatewayAt)]},
    {id:'platform-foreground-recovery',kind:'foreground',plugin:'@deepseek-ai/dsh-api-gateway',description:'前台恢复与受控自动重连',anchor,marker,previous:constant('previousMarker',gatewayAt),end:constant('endMarker',gatewayAt),applied:recovery},
    ...routes,
    {id:'platform-eager-iterator',kind:'iterator',plugin:'@deepseek-ai/dsh-client-ui-sidebar-documentpreview',description:'预览模块首屏禁止裸Iterator解引用',forbidden:'typeof Iterator.prototype.join'},
    {id:'platform-composer-background',kind:'composer',plugin:'@deepseek-ai/dsh-client-ui-conversation',description:'老引擎输入区背景兼容',targetFile:'lib/client.js',anchor:constant('anchor',composerAt),applied:stringAt(patcher,patcher.indexOf('.join(',composerAt)+'.join('.length).value},
    {id:'platform-legacy-shim',kind:'shim',plugin:'@deepseek-ai/dsh-web-frontend',description:'旧浏览器兼容shim完整性',targetFile:'dist/index.html',marker:constant('marker',shimAt),end:'<!-- dsh-legacy-compat:end -->',applied:block,polyfillSHA256:sha(polyfill)}
  ];
  return {schemaVersion:1,source:'PowerHarness/scripts/patch-dsh.mjs',scriptSHA256:sha(patcher),rules};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.length!==3)throw Error('Usage: node export-platform-patches.mjs <output.json>');
  const output=path.resolve(process.argv[2]);
  const catalog=createPlatformCatalog(fs.readFileSync(path.join(directory,'patch-dsh.mjs'),'utf8'),fs.readFileSync(path.join(directory,'legacy-compat.js'),'utf8'));
  const bytes=JSON.stringify(catalog,null,2)+LF;
  if(fs.existsSync(output)) {
    if(fs.readFileSync(output,'utf8')!==bytes)throw Error('输出已存在且内容不同，保留原件，请使用新的构建路径');
  } else fs.writeFileSync(output,bytes,{flag:'wx',mode:0o644});
  console.log(JSON.stringify({output,rules:catalog.rules.length,sourceSHA256:catalog.scriptSHA256}));
}
