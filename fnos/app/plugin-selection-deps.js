/**
 * 首次安装「可选插件」勾选的依赖联动。
 *
 * 规则（用户 2026-11-06 明确要求）：
 *   - 勾选某插件时，它依赖的插件必须同步勾选；
 *   - 取消勾选某插件时，依赖它的插件必须同步取消。
 *
 * 依赖关系来自 bundled-plugins.json 里每个包的 dependencies/peerDependencies 中
 * 指向另一个【同为捆绑候选】的条目 —— 只有候选集内的依赖才需要在向导里联动。

 * 设计要点：
 *   - 不引入新字段。候选集里本来没有依赖声明，就无需联动。
 *   - 传染用不动点迭代，避免"A 依赖 B、B 依赖 C"只走一层。
 *   - 取消是反向传染：谁依赖被取消的项，谁跟着取消。
 *   - 结果保持候选集原有顺序，便于向导稳定渲染。
 */

/** 从候选条目里取出"依赖了候选集内其他插件"的边：required 为 must，optional 为 soft */
export function dependencyEdges(entries, manifests) {
  const names = new Set(entries.map((entry) => entry.name));
  const must = new Map();
  const soft = new Map();
  for (const entry of entries) {
    const manifest = manifests[entry.name] || {};
    const meta = manifest.peerDependenciesMeta || {};
    const hardDeps = Object.keys(manifest.dependencies || {});
    const peerDeps = Object.keys(manifest.peerDependencies || {});
    for (const dep of hardDeps) {
      if (!names.has(dep) || dep === entry.name) continue;
      if (!must.has(entry.name)) must.set(entry.name, []);
      must.get(entry.name).push(dep);
    }
    for (const dep of peerDeps) {
      if (!names.has(dep) || dep === entry.name) continue;
      const optional = Boolean(meta[dep] && meta[dep].optional);
      const bucket = optional ? soft : must;
      if (!bucket.has(entry.name)) bucket.set(entry.name, []);
      bucket.get(entry.name).push(dep);
    }
  }
  return { must, soft };
}

/** 勾选 name 后，必须一并勾选的集合（含 name 自身）。optional 边不传染。 */
export function withDependencies(selected, edges) {
  const next = new Set(selected);
  const queue = [...next];
  while (queue.length) {
    const name = queue.shift();
    for (const dep of edges.must.get(name) || []) {
      if (next.has(dep)) continue;
      next.add(dep);
      queue.push(dep);
    }
  }
  return next;
}

/**
 * 取消 name 后必须一并取消的集合（含 name 自身）。
 *
 * 语义只有一条：只要某个仍被选中的插件，其硬依赖里出现「已不在选中集合」的项，
 * 它就必须跟着取消；反复迭代直到稳定。这样 A→B→C 的链上取消中间任何一环，
 * 上游与下游都会收敛，且不受"先删谁"的顺序影响。
 */
export function withoutDependents(selected, removed, edges) {
  const next = new Set(selected);
  next.delete(removed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of [...next]) {
      const deps = edges.must.get(name) || [];
      if (deps.some((dep) => !next.has(dep))) {
        next.delete(name);
        changed = true;
      }
    }
  }
  return next;
}

/** 把勾选结果映射回候选顺序的数组 */
export function normalize(entries, selected) {
  return entries.filter((entry) => selected.has(entry.name)).map((entry) => entry.name);
}
