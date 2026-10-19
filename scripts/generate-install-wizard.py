#!/usr/bin/env python3
import json,hashlib,sys
from pathlib import Path
stage=Path(sys.argv[1]).resolve();wizard=stage/'wizard/install';callback=stage/'cmd/install_callback';index=stage/'app/plugins-bundled/bundled-plugins.json'
steps=json.loads(wizard.read_text());entries=json.loads(index.read_text())['plugins'] if index.exists() else []
items=[{'type':'tips','helpText':'以下为可选插件的离线资源，默认不安装。可逐个选择或全部跳过；升级保留当前插件与启用状态，不自动补装。不会携带原用户配置、账号或凭据。'}]
exports=[]
for entry in entries:
 field='wizard_plugin_'+hashlib.sha256(entry['name'].encode()).hexdigest()[:12];exports.append('export '+field+'="'+chr(36)+'{'+field+':-false}"')
 items.append({'type':'select','field':field,'label':entry['name']+' @ '+entry['version'],'initValue':'false','options':[{'label':'不安装','value':'false'},{'label':'安装','value':'true'}]})
steps.append({'stepTitle':'可选插件（'+str(len(entries))+'项）','items':items})
wizard.write_text(json.dumps(steps,ensure_ascii=False,indent=2)+chr(10))
text=callback.read_text();needle='node "';pos=text.index(needle);callback.write_text(text[:pos]+chr(10).join(exports)+chr(10)+text[pos:])
print('Generated install choices:',len(entries))
