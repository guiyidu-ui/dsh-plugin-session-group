// dsh-plugin-session-group v3 — client half (browser bundle).
//
// 侧边栏会话列表双视图：
//   * 「按项目分组」视图（默认）：shadow 内置 `sidebar.workspaces` 单槽，
//     按 cwd 的「首层 AI share 子目录」分组渲染，支持
//     - 组头/会话行拖拽换组（HTML5 DnD，覆盖式分组，不改会话归属/cwd）
//     - 手动新建分组 / 重命名 / 删除
//     - 组头新建会话：在该项目目录下创建带 cwd 的新会话（项目上下文）
//     - 会话行显示所属项目徽标
//     - 组头置顶、顶栏搜索过滤、视图切换（分组 ⇄ 原始）
//   * 「原始」视图：注销本插件对 sidebar.workspaces 的接管，让 DSH 原生
//     WorkspaceBrowser 按原有上下文正常渲染（完整内置能力：搜索、新建、
//     拖拽排序、工作区管理）。
//
// 设计取舍：
//   * 覆盖式分组只存 localStorage（sessionId → custom group key），
//     不改会话 cwd / workspace 归属，审批边界不变
//   * 组 = 按 cwd 的「首层子目录」聚类（以 DSH 工作区根为基准）：
//       cwd 在 <DSH_WORKSPACE>\<X> 下 → 组「X」；
//       cwd = 工作区根 / 无 cwd / 树外 → 组「根 / 其他」
//     + 用户自定义组（manual:<name>）
//   * 折叠状态/视图模式/置顶 按浏览器持久化到 localStorage
//
// 生效方式：纯客户端 bundle（no-cache，刷新页面即生效）；
//   插件集变更需 web 宿主重启（watchdog 配方）。
window.__ModuleLoader__.load({
  id: "dsh-plugin-session-group",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var useState = react.useState;
    var useEffect = react.useEffect;
    var useMemo = react.useMemo;
    var useCallback = react.useCallback;
    var useRef = react.useRef;
    var createElement = react.createElement;
    var Fragment = react.Fragment;

    //#region helpers
    var WORKSPACE_PREFIX = "e:\\ai share\\";
    var WORKSPACE_ROOT = "e:\\ai share";
    var LS_KEY = "dsh-plugin-session-group/v2";
    var DEFAULT_GROUP = "default";
    var DND_MIME = "application/x-sg-session";

    function norm(p) {
      if (typeof p !== "string") return "";
      var s = String(p).replace(/\//g, "\\");
      while (s.length > 1 && (s.charAt(s.length - 1) === "\\" || s.charAt(s.length - 1) === "/")) s = s.slice(0, -1);
      return s.toLowerCase();
    }

    /** cwd → 项目组 key；首层 AI share 子目录名为组名，树外/根/无 cwd → 默认组。 */
    function groupKeyOf(cwd) {
      var c = norm(cwd);
      if (!c) return DEFAULT_GROUP;
      if (c === WORKSPACE_ROOT) return DEFAULT_GROUP;
      if (c.indexOf(WORKSPACE_PREFIX) === 0) {
        var rest = c.slice(WORKSPACE_PREFIX.length);
        var slash = rest.indexOf("\\");
        var first = slash === -1 ? rest : rest.slice(0, slash);
        if (first) return "dir:" + first;
        return DEFAULT_GROUP;
      }
      return "root:" + c;
    }

    function groupLabelOf(key, customGroups) {
      if (key === DEFAULT_GROUP) return "AI share 根 / 其他";
      if (key.indexOf("dir:") === 0) return key.slice(4);
      if (key.indexOf("root:") === 0) return key.slice(5);
      if (key.indexOf("manual:") === 0) return (customGroups && customGroups[key]) ? customGroups[key].name : key.slice(7);
      return key;
    }

    /** cwd 对应的项目目录绝对路径（用于组头新建会话；默认组返回根）。 */
    function groupCwdPath(key) {
      if (key === DEFAULT_GROUP) return WORKSPACE_ROOT;
      if (key.indexOf("dir:") === 0) return WORKSPACE_PREFIX + key.slice(4);
      if (key.indexOf("root:") === 0) return key.slice(5);
      return null;
    }

    /** 相对时间：今天 HH:mm；今年 M/D HH:mm；跨年 YYYY/M/D。 */
    function fmtTime(ms) {
      if (!ms || !Number.isFinite(ms)) return "";
      var d = new Date(ms);
      var now = new Date();
      var hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
      if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
      return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
    }

    /** localStorage 读写（容错：隐私模式/禁用时静默降级为纯内存）。 */
    function readState() {
      try {
        var raw = window.localStorage.getItem(LS_KEY);
        if (!raw) return {};
        var obj = JSON.parse(raw);
        return (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {};
      } catch (err) { return {}; }
    }
    function writeState(state) {
      try { window.localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
    }
    /** 惰性物化持久化状态：折叠态/覆盖分组/自定义组/置顶/视图模式。 */
    function initState(base) {
      var s = base && typeof base === "object" ? base : {};
      if (!s.collapsed) s.collapsed = {};
      if (!s.overrides || typeof s.overrides !== "object") s.overrides = {};
      if (!s.customGroups || typeof s.customGroups !== "object") s.customGroups = {};
      if (!s.pinned || typeof s.pinned !== "object") s.pinned = {};
      if (!s.order || typeof s.order !== "object") s.order = {};
      if (s.viewMode !== "grouped" && s.viewMode !== "builtin") s.viewMode = "grouped";
      return s;
    }
    /**
     * View mode is shared by the sidebar registration and the overlay switch.
     * Keeping it outside React lets the plugin register/dispose its sidebar
     * shadow synchronously when the user switches views.
     */
    var viewModeListeners = new Set();
    var currentViewMode = initState(readState()).viewMode;
    function getViewMode() { return currentViewMode; }
    function subscribeViewMode(listener) {
      viewModeListeners.add(listener);
      return function () { viewModeListeners.delete(listener); };
    }
    function setViewMode(mode) {
      var next = mode === "builtin" ? "builtin" : "grouped";
      if (next === currentViewMode) return;
      var s = initState(readState());
      s.viewMode = next;
      writeState(s);
      currentViewMode = next;
      viewModeListeners.forEach(function (listener) {
        try { listener(); } catch (err) { console.warn("[session-group] view mode listener failed:", err); }
      });
    }
    function isCollapsed(map, key) { return map[key] === true; }
    function toggleCollapsed(map, key) {
      var next = Object.assign({}, map);
      next[key] = !isCollapsed(map, key);
      if (next[key] === false) delete next[key];
      return next;
    }
    /** 会话的有效分组 key（覆盖 > cwd 推导）。 */
    function effectiveGroupKey(session, overrides) {
      if (overrides[session.id]) return overrides[session.id];
      return groupKeyOf(session.cwd);
    }

    /** 把会话列表 + 工作区投影折成分组结构（纯函数，可单测）。
     *  规则：
     *   - 父会话按「覆盖映射 > cwd」分组；
     *   - 子代理会话（parentId）跟随父会话所在组，渲染时缩进；
     *   - 组内按 updatedAt 倒序；组间按置顶 > 会话数倒序、默认组垫底。
     */
    function deriveGroupedSessions(list, workspaces, overrides, pinned) {
      var byId = (list && list.byId) || {};
      var ids = (list && list.ids) || [];
      var current = list && list.current;
      var archivedSet = new Set();
      if (workspaces && Array.isArray(workspaces.archivedSessionIds)) {
        for (var a = 0; a < workspaces.archivedSessionIds.length; a++) archivedSet.add(workspaces.archivedSessionIds[a]);
      }
      var parents = [];
      var seen = new Set();
      for (var i = 0; i < ids.length; i++) {
        var s = byId[ids[i]];
        if (!s || seen.has(s.id)) continue;
        seen.add(s.id);
        if (archivedSet.has(s.id)) continue;
        if (s.parentId && byId[s.parentId]) continue;
        if (s.origin === "subagent" && s.id !== current) continue;
        parents.push(s);
      }
      var childrenOf = new Map();
      for (var j = 0; j < ids.length; j++) {
        var cs = byId[ids[j]];
        if (!cs || !cs.parentId || archivedSet.has(cs.id)) continue;
        var parentKey = cs.parentId;
        if (byId[parentKey] === undefined) continue;
        var arr = childrenOf.get(parentKey) || [];
        arr.push({ session: cs, depth: 0 });
        childrenOf.set(parentKey, arr);
      }
      var groupsMap = new Map();
      function ensure(key) {
        if (!groupsMap.has(key)) groupsMap.set(key, { key: key, sessions: [], count: 0 });
        return groupsMap.get(key);
      }
      function countDescendants(id) {
        var n = 0;
        var kids = childrenOf.get(id);
        if (kids) for (var x = 0; x < kids.length; x++) n += 1 + countDescendants(kids[x].session.id);
        return n;
      }
      for (var k = 0; k < parents.length; k++) {
        var p = parents[k];
        var key = effectiveGroupKey(p, overrides);
        var g = ensure(key);
        g.sessions.push(p);
        g.count += 1 + countDescendants(p.id);
      }
      var groups = Array.from(groupsMap.values());
      for (var gg = 0; gg < groups.length; gg++) {
        groups[gg].sessions.sort(function (x, y) { return (y.updatedAt || 0) - (x.updatedAt || 0); });
      }
      groups.sort(function (x, y) {
        var xp = pinned && pinned[x.key] ? 1 : 0;
        var yp = pinned && pinned[y.key] ? 1 : 0;
        if (xp !== yp) return yp - xp;
        if (x.key === DEFAULT_GROUP && y.key !== DEFAULT_GROUP) return 1;
        if (y.key === DEFAULT_GROUP && x.key !== DEFAULT_GROUP) return -1;
        if (y.count !== x.count) return y.count - x.count;
        return x.key < y.key ? -1 : 1;
      });
      return { groups: groups, childrenOf: childrenOf, current: current };
    }

    /** 组内手动排序：order[groupKey] 是有序会话 id 数组（拖曳定位写入）。
     *  数组内会话按数组顺序排前；其余会话（新会话/被移出数组的）按 updatedAt
     *  倒序排后。order 为空/缺失 → 纯 updatedAt 倒序（与旧行为一致）。 */
    function sortGroupSessions(sessions, orderArr) {
      var list = (sessions || []).slice();
      if (!Array.isArray(orderArr) || orderArr.length === 0) {
        list.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
        return list;
      }
      var pos = new Map();
      for (var i = 0; i < orderArr.length; i++) pos.set(orderArr[i], i);
      var inOrder = list.filter(function (s) { return pos.has(s.id); });
      var rest = list.filter(function (s) { return !pos.has(s.id); });
      inOrder.sort(function (a, b) { return pos.get(a.id) - pos.get(b.id); });
      rest.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      return inOrder.concat(rest);
    }

    /** 搜索过滤：标题/displayTitle 含 query（不区分大小写）。 */
    function filterSessions(groups, query) {
      var q = String(query || "").trim().toLowerCase();
      if (!q) return groups;
      return groups.map(function (g) {
        var matched = g.sessions.filter(function (s) {
          var t = (s.displayTitle || s.title || s.id || "").toLowerCase();
          return t.indexOf(q) !== -1;
        });
        if (matched.length === 0) return null;
        return { key: g.key, sessions: matched, count: matched.length };
      }).filter(Boolean);
    }

    /** 项目徽标文本（cwd → 首层目录名；根 → 根；树外 → 末段）。 */
    function projectBadgeText(session) {
      var c = norm(session.cwd);
      if (!c) return null;
      if (c === WORKSPACE_ROOT) return "根";
      if (c.indexOf(WORKSPACE_PREFIX) === 0) {
        var rest = c.slice(WORKSPACE_PREFIX.length);
        var slash = rest.indexOf("\\");
        var first = slash === -1 ? rest : rest.slice(0, slash);
        return first || null;
      }
      var parts = c.split("\\");
      return parts[parts.length - 1] || null;
    }
    //#endregion

    //#region styles
    var groupCss = ".sg-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-text-primary,inherit)}.sg-head{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));flex:0 0 auto}.sg-title{font-weight:600;font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-text-tertiary,#8a8f98)}.sg-headbtn{border:none;background:transparent;cursor:pointer;font-size:12px;color:var(--dsw-alias-text-tertiary,#8a8f98);padding:2px 6px;border-radius:6px;line-height:1}.sg-headbtn:hover{background:rgba(128,128,128,.12);color:var(--dsw-alias-text-primary,inherit)}.sg-viewtoggle{display:flex;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:8px;overflow:hidden;flex:0 0 auto}.sg-viewtoggle button{border:none;background:transparent;cursor:pointer;font-size:12px;padding:3px 8px;color:var(--dsw-alias-text-tertiary,#8a8f98);font-family:inherit;line-height:1.2}.sg-viewtoggle button.active{background:rgba(128,128,128,.16);color:var(--dsw-alias-text-primary,inherit);font-weight:600}.sg-search{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-radius:8px;background:transparent;padding:3px 8px;font-size:12px;color:var(--dsw-alias-text-primary,inherit);width:110px;outline:none;font-family:inherit;flex:0 0 auto}.sg-search:focus{border-color:rgba(128,128,128,.5)}.sg-body{flex:1;overflow-y:auto;padding:6px 6px 16px}.sg-group{margin-bottom:2px}.sg-group.dropTarget>.sg-grouphead{background:rgba(80,160,255,.18);outline:1px dashed rgba(80,160,255,.6);outline-offset:-1px}.sg-grouphead{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:none;background:transparent;cursor:pointer;padding:7px 8px;border-radius:8px;font-size:13px;color:inherit;font-family:inherit;position:relative}.sg-grouphead:hover{background:rgba(128,128,128,.1)}.sg-caret{font-size:10px;color:var(--dsw-alias-text-tertiary,#8a8f98);width:10px;flex:0 0 auto;transition:transform .12s}.sg-caret.open{transform:rotate(90deg)}.sg-gpin{flex:0 0 auto;font-size:10px}.sg-glabel{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;min-width:0}.sg-gcount{font-size:11px;color:var(--dsw-alias-text-tertiary,#8a8f98);flex:0 0 auto}.sg-gactions{display:none;position:absolute;right:4px;top:50%;transform:translateY(-50%);gap:2px;background:inherit;padding:1px 2px;border-radius:6px}.sg-grouphead:hover .sg-gactions{display:flex}.sg-gact{border:none;background:transparent;cursor:pointer;font-size:11px;color:var(--dsw-alias-text-tertiary,#8a8f98);padding:1px 4px;border-radius:4px;line-height:1}.sg-gact:hover{background:rgba(128,128,128,.18);color:var(--dsw-alias-text-primary,inherit)}.sg-newin{border:none;background:transparent;cursor:pointer;font-size:11px;color:var(--dsw-alias-text-tertiary,#8a8f98);padding:3px 10px 3px 22px;border-radius:6px;line-height:1;flex:0 0 auto;width:100%;text-align:left;font-family:inherit}.sg-newin:hover{background:rgba(80,160,255,.14);color:var(--dsw-alias-text-primary,inherit)}.sg-addgroup{display:flex;align-items:center;gap:4px;width:calc(100% - 4px);margin:8px 2px 4px;border:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.3));background:transparent;cursor:pointer;padding:6px 10px;border-radius:8px;font-size:12px;color:var(--dsw-alias-text-tertiary,#8a8f98);font-family:inherit}.sg-addgroup:hover{background:rgba(128,128,128,.08);color:var(--dsw-alias-text-primary,inherit)}.sg-row{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:none;background:transparent;cursor:pointer;padding:6px 8px 6px 14px;border-radius:8px;font-size:13px;color:inherit;font-family:inherit}.sg-row:hover{background:rgba(128,128,128,.1)}.sg-row.current{background:rgba(128,128,128,.16);font-weight:600}.sg-row.dragging{opacity:.35}.sg-child .sg-row{padding-left:28px;font-size:12.5px}.sg-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}.sg-dot.running{background:var(--dsw-alias-status-running,#f59e0b)}.sg-dot.completed{background:var(--dsw-alias-status-completed,#22c55e)}.sg-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.sg-proj{flex:0 0 auto;font-size:10px;padding:1px 5px;border-radius:6px;background:rgba(128,128,128,.14);color:var(--dsw-alias-text-tertiary,#8a8f98);max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sg-proj.custom{background:rgba(80,160,255,.18);color:var(--dsw-alias-text-secondary,#aab2bf)}.sg-time{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-text-tertiary,#8a8f98)}.sg-actions{display:none;gap:2px;flex:0 0 auto}.sg-row:hover .sg-actions{display:flex}.sg-act{border:none;background:transparent;cursor:pointer;font-size:11px;color:var(--dsw-alias-text-tertiary,#8a8f98);padding:1px 4px;border-radius:4px;line-height:1}.sg-act:hover{background:rgba(128,128,128,.18);color:var(--dsw-alias-text-primary,inherit)}.sg-rename{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4));border-radius:6px;padding:4px 8px;font-size:13px;color:var(--dsw-alias-text-primary,inherit);background:transparent;outline:none;font-family:inherit}.sg-empty{padding:18px 12px;color:var(--dsw-alias-text-tertiary,#8a8f98);text-align:center;font-size:12px}.sg-foot{flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;padding:6px 10px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));font-size:11px;color:var(--dsw-alias-text-tertiary,#8a8f98)}.sg-builtin-body{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column}.sg-row-wrap.sg-drop-before{box-shadow:0 -2px 0 0 rgba(80,160,255,.9)} .sg-row-wrap.sg-drop-after{box-shadow:0 2px 0 0 rgba(80,160,255,.9)}";
    var overlayCss = ".sg-view-return{position:fixed;left:12px;bottom:16px;z-index:35;display:flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:9px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-text-primary,inherit);box-shadow:0 3px 14px rgba(0,0,0,.16);padding:7px 11px;font:600 12px/1.2 inherit;cursor:pointer}.sg-view-return:hover{border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1,rgba(128,128,128,.5)));background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base,#fff))}";
    var groupTagId = "dsh-plugin-session-group/session-group.css";
    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(groupTagId) + "]") !== null) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-plugin-session-group";
      tag.dataset.pluginCss = groupTagId;
      tag.textContent = groupCss + overlayCss;
      document.head.appendChild(tag);
    }
    //#endregion

    //#region builtin view (原始视图)
    /** 内置 dsh-client-ui-workspace 的 apply() 在宿主 boot 时已成功执行
     *  （诊断日志 "registered by H5" / "uiWorkspace has been registered at
     *  <H5>" 证实），WorkspaceBrowser 条目已注册到 sidebar.workspaces 槽。
     *  本插件条目（priority 0，default）占 [0]（single 槽只渲染 [0]），
     *  内置条目仍在 entries 列表里（只是被本插件 shadow 掉、没被宿主直接
     *  渲染）。原始视图从 entries 中找到内置条目并直接渲染其组件，
     *  不重复执行内置 apply（二次注册必然抛 "already has a registration"）。 */

    /** 判断一个 entry 是否本插件条目（id === "session-group"）。 */
    function isPluginEntry(e) {
      return !!(e && e.options && e.options.id === "session-group");
    }
    /** 从 sidebar.workspaces 槽的 entries 中找到内置条目（非本插件条目）。
     *  匹配策略：跳过本插件条目（options.id === "session-group"），返回其余
     *  首个带组件的条目（内置 WorkspaceBrowser）。单槽可能只有 1 条 entries
     *  （本插件 shadow 掉内置、内置被挤出）或 2 条（本插件 + 内置）——两种
     *  都能处理。找不到返回 null。 */
    function findBuiltinEntry(ctx) {
      try {
        var entries = ctx.slots.entries("sidebar.workspaces");
        if (!entries || entries.length === 0) return null;
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          if (!e || isPluginEntry(e)) continue;
          if (e.component && typeof e.component === "function") return e;
        }
        return null;
      } catch (err) {
        console.warn("[session-group] 读取 sidebar.workspaces entries 失败:", err);
        return null;
      }
    }

    /** 把内置 entry.inject() 返回的 face 解析成：
     *   plain: plain 回调 props（startSession/open/searchSessions 等）
     *   sources: face.hooks 的 { name → observable source } 映射
     *  纯解析，无 hook 调用（hook 在 BuiltinBrowserView 渲染期固定位置调用）。 */
    function resolveEntryFace(entry) {
      var plain = {};
      var sources = {};
      try {
        if (typeof entry.inject === "function") {
          var face = entry.inject();
          if (face && typeof face === "object") {
            var rest = Object.assign({}, face);
            sources = (typeof rest.hooks === "object" && rest.hooks) ? rest.hooks : {};
            delete rest.hooks;
            delete rest.keyedHooks;
            plain = rest;
          }
        }
      } catch (err) {
        console.warn("[session-group] 内置条目 inject 解析失败:", err);
      }
      return { plain: plain, sources: sources };
    }
    /** 本地等价实现宿主槽渲染器的 renderSlot：
     *  对内置 entry 声明的 children 子槽，渲染该槽当前胜出的注册项
     *  （entriesOfSlot 首项 = 宿主渲染口径），并给胜出项拼装等价 props
     *  （其 inject 的 plain 回调 + 子槽自身 inject 的 plain 回调）。
     *  未声明的 key 返回 null；未注册项的子槽渲染为占位空层。
     *  注意：这里不套 React 边界/缓存 —— 插件渲染树与宿主渲染树是同一个
     *  React root（宿主把插件条目渲染在 RootEntry 里），胜出项组件本身
     *  就是 React 组件，直接 createElement 等价于宿主 guarded(entry)。 */
    function makeRenderSlot(ctx, entry) {
      return function (key, owner, opts) {
        try {
          var decl = entry.children && entry.children[key];
          if (!decl) return null;
          var winners = (ctx.slots && typeof ctx.slots.entriesOfSlot === "function")
            ? ctx.slots.entriesOfSlot(key)
            : null;
          var win = winners && winners.length > 0 ? winners[0] : null;
          if (!win) return null;
          var winProps = (owner && typeof owner === "object") ? Object.assign({}, owner) : {};
          // 子槽级 inject（spec.inject，宿主 cachedSlotInject 的 plain props 部分）
          try {
            if (ctx.slots && typeof ctx.slots.spec === "function") {
              var spec = ctx.slots.spec(key);
              if (spec && typeof spec.inject === "function") {
                var sface = spec.inject();
                if (sface && typeof sface === "object") {
                  var srest = Object.assign({}, sface);
                  delete srest.hooks;
                  delete srest.keyedHooks;
                  Object.assign(winProps, srest);
                }
              }
            }
          } catch (e) { /* ignore */ }
          // 胜出项自身 inject（plain 回调 props）
          try {
            if (typeof win.inject === "function") {
              var wface = win.inject();
              if (wface && typeof wface === "object") {
                var wrest = Object.assign({}, wface);
                delete wrest.hooks;
                delete wrest.keyedHooks;
                Object.assign(winProps, wrest);
              }
            }
          } catch (e) { /* ignore */ }
          var renderSlotInner = makeRenderSlot(ctx, win);
          var Comp2 = win.component;
          if (typeof Comp2 !== "function") return null;
          return createElement(Comp2, Object.assign(winProps, { renderSlot: renderSlotInner }));
        } catch (err) {
          console.warn("[session-group] 子槽渲染失败 " + key + ":", err);
          return null;
        }
      };
    }
    /** 原始视图：委托宿主 renderSlot 渲染内置 WorkspaceBrowser 条目。
     *
     *  关键认识（第五轮定位）：
     *  内置 dsh-client-ui-workspace 的 apply() 在宿主 boot 时**已经成功执行**
     *  （诊断日志 "registered by H5" / "service \"uiWorkspace\" has been
     *  registered at <H5>" 证实），WorkspaceBrowser 条目已注册到
     *  sidebar.workspaces 槽。前四轮"补做内置 apply"的方向全错 —— 它们试图
     *  二次注册一个已存在的条目，必然抛 "already has a registration at
     *  priority 0" / "uiWorkspace has been registered"。
     *
     *  正确做法：本插件条目（priority 0，default）占 sidebar.workspaces 槽的
     *  [0]（single 槽只渲染 [0]），宿主把本插件条目作为胜出者渲染，并在其
     *  props（slotProps）里下发宿主构建的 renderSlot 绑定（boundRenderSlot）。
     *  该 renderSlot 是宿主 SlotOutlet 的渲染入口 —— 调用
     *  slotProps.renderSlot("sidebar.workspaces", ownerProps) 会渲染该槽的
     *  胜出条目（entriesOfSlot[0]）。
     *
     *  问题：宿主 renderSlot 渲染的是该槽的 [0] 胜出者 = 本插件条目自己
     *  （因为本插件 priority 0 占 [0]），会递归到自身。
     *
     *  解决：渲染期临时把本插件条目的优先级"让位" —— 不行，register 是
     *  一次性的。
     *
     *  替代方案（本实现）：直接找到内置条目（entries 里非 session-group 的那
     *  个），用本地 makeRenderSlot + resolveEntryFace 拼装等价 props，渲染其
     *  组件。这绕过了"renderSlot 渲染 [0] = 自己"的递归问题，直接渲染内置
     *  条目。标准 kit（useSessions/useWorkspaces/t/useStore/actions）由宿主
     *  经 ownerProps（slotProps）下发 —— 宿主 renderEntry 的 kit 展开与
     *  slotProps 在同一 props 对象里，所以 slotProps 里已含 useSessions/
     *  useWorkspaces/useStore/actions/t。本视图只需补 entry.inject 的 plain
     *  回调 props + hooks 包成 useXxx + renderSlot（本地等价）。 */
    function BuiltinBrowserView(props) {
      var ctx = props.ctx;
      var slotProps = props.slotProps || {};
      var [entry, setEntry] = useState(function () { return findBuiltinEntry(ctx); });

      // 若首次渲染未找到（极端时序），延迟重试一次
      useEffect(function () {
        if (entry) return;
        var t = window.setTimeout(function () {
          var f = findBuiltinEntry(ctx);
          if (f) setEntry(f);
        }, 200);
        return function () { window.clearTimeout(t); };
      }, []);

      if (!entry) {
        // 诊断：把 entries 实际形状直接渲染到页面（不依赖 F12 展开），
        // 同时写入 window.__sgDiag。
        var diagText = "";
        try {
          var es = ctx.slots.entries("sidebar.workspaces");
          var diag = {
            count: es ? es.length : 0,
            entries: (es || []).map(function (e) {
              return {
                registrant: e.registrant || null,
                id: e.options && e.options.id,
                name: e.options && e.options.name,
                priority: e.options && e.options.priority,
                hasComponent: !!(e.component && typeof e.component === "function"),
                componentType: e.component ? typeof e.component : "absent",
                isPlugin: isPluginEntry(e)
              };
            })
          };
          window.__sgDiag = diag;
          console.warn("[session-group] diagnose entries:", diag);
          diagText = "entries 共 " + diag.count + " 条：\n" +
            diag.entries.map(function (d, i) {
              return "  [" + i + "] registrant=" + d.registrant +
                " id=" + d.id + " name=" + d.name +
                " priority=" + d.priority +
                " component=" + d.componentType +
                " isPlugin=" + d.isPlugin;
            }).join("\n");
        } catch (err) {
          diagText = "diagnose 失败: " + String((err && err.message) || err);
        }
        return createElement("div", { className: "sg-root" },
          createElement("div", { className: "sg-empty", style: { whiteSpace: "pre-wrap", fontFamily: "monospace", fontSize: "12px" } },
            "原始视图：未找到内置会话列表条目\n",
            diagText, createElement("br", null),
            "（F12 查 window.__sgDiag）"));
      }
      // 拼装 props：slotProps(宿主 ownerProps，含标准 kit) + entry.inject plain
      //   + entry.inject hooks 包成 useXxx + 本地 renderSlot
      var face = resolveEntryFace(entry);
      var sourceNames = Object.keys(face.sources).sort();
      // 诊断：把 slotProps / face.plain / face.sources 的实际内容渲染到页面
      // （组件崩溃时诊断也在页面，截图即见；不依赖 F12 展开）。
      // 一次性：首次渲染时计算并缓存到 window.__sgPropsDiag，后续渲染复用。
      if (!window.__sgPropsDiag) {
        try {
          var spKeys = Object.keys(slotProps);
          var spTypes = {};
          for (var sk = 0; sk < spKeys.length; sk++) {
            var sv = slotProps[spKeys[sk]];
            spTypes[spKeys[sk]] = typeof sv;
          }
          var plainTypes = {};
          var pk = Object.keys(face.plain);
          for (var pk2 = 0; pk2 < pk.length; pk2++) {
            plainTypes[pk[pk2]] = typeof face.plain[pk[pk2]];
          }
          var srcShapes = sourceNames.map(function (n) {
            var s = face.sources[n];
            if (!s) return n + "=null";
            var g = typeof s.getSnapshot === "function" ? s.getSnapshot() : null;
            return n + "{get:" + typeof s.getSnapshot + ",sub:" + typeof s.subscribe +
              ",snap:" + (g === null ? "null" : (g === undefined ? "undefined" : typeof g)) + "}";
          });
          window.__sgPropsDiag = {
            slotPropsKeys: spKeys,
            slotPropsTypes: spTypes,
            plainKeys: pk,
            plainTypes: plainTypes,
            sourceNames: sourceNames,
            sourceShapes: srcShapes,
            hasStore: !!(entry.store),
            storeType: entry.store ? typeof entry.store : "absent"
          };
          console.warn("[session-group] props diag:", window.__sgPropsDiag);
        } catch (err) {
          window.__sgPropsDiag = { error: String((err && err.message) || err) };
          console.warn("[session-group] props diag 失败:", err);
        }
      }
      var hookValues = [];
      // 固定 hook 槽位：WorkspaceBrowser 必用 useHostInfo + useDirectoryFlow
      // （selector hook 语义：useHostInfo((info)=>info.home)）。无论
      // entry.inject() 是否成功都返回函数（保证组件不收到 undefined、hooks
      // 顺序稳定）。inject 成功用真实 source；失败用稳定 undefined 兜底
      // （WorkspaceBrowser 对 home 缺失/directoryFlowAvailable=false 有空值处理）。
      //
      // 实现：subscribe 订阅 source，getSnapshot 返回 source 原始 snapshot，
      // 再用 useMemo 应用 selector（与宿主 useSyncExternalStoreWithSelector
      // 行为等价：selector 每次渲染可不同，但 subscribe/snapshot 源稳定）。
      function makeSelectorHook(src) {
        // src 可能为 null（inject 失败）→ 稳定 undefined
        var hasSrc = !!(src && typeof src.getSnapshot === "function" && typeof src.subscribe === "function");
        var subscribe = hasSrc
          ? function (fn) { try { return src.subscribe(fn) || function () {}; } catch (e) { return function () {}; } }
          : function () { return function () {}; };
        var getSnap = hasSrc
          ? function () { try { return src.getSnapshot(); } catch (e) { return undefined; } }
          : function () { return undefined; };
        var raw = react.useSyncExternalStore(subscribe, getSnap, getSnap);
        return function (selector, equal) {
          var sel = selector || function (v) { return v; };
          return react.useMemo(function () {
            try { return sel(raw); } catch (e) { return undefined; }
          }, [raw]);
        };
      }
      var HOOK_SLOTS = ["directoryFlow", "hostInfo"];
      for (var hs = 0; hs < HOOK_SLOTS.length; hs++) {
        hookValues.push(makeSelectorHook(face.sources[HOOK_SLOTS[hs]]));
      }
      var injected = Object.assign({}, face.plain);
      for (var hn = 0; hn < HOOK_SLOTS.length; hn++) {
        var nm = HOOK_SLOTS[hn];
        injected["use" + nm.charAt(0).toUpperCase() + nm.slice(1)] = hookValues[hn];
      }
      var renderSlot = makeRenderSlot(ctx, entry);
      // 内置条目声明了 store（createWorkspaceViewStore handle），WorkspaceBrowser
      // 需要 useStore（selector hook）+ actions。slotProps 是**本插件条目**的 kit，
      // 不含内置条目的 store。ctx.slots 上无公开 resolveStore（私有方法），
      // 正确路径：ctx.slots.hostFace().storeOf(entry, scopeBinding)。
      // 内置条目 scope=root，scopeBinding 传 undefined（resolveStore root 分支
      // 忽略第二个参数，用 ROOT_INSTANCE_KEY 取实例）。
      var storeInstance = null;
      try {
        if (entry.store && ctx.slots && typeof ctx.slots.hostFace === "function") {
          var host = ctx.slots.hostFace();
          if (host && typeof host.storeOf === "function") {
            storeInstance = host.storeOf(entry, undefined);
          }
        }
      } catch (err) {
        console.warn("[session-group] 解析内置 store 失败:", err);
      }
      // useStore selector hook（订阅 storeInstance.subscribe / getSnapshot）
      var useStoreHook = (function () {
        var sub = (storeInstance && typeof storeInstance.subscribe === "function")
          ? function (fn) { try { return storeInstance.subscribe(fn) || function () {}; } catch (e) { return function () {}; } }
          : function () { return function () {}; };
        var snap = (storeInstance && typeof storeInstance.getSnapshot === "function")
          ? function () { try { return storeInstance.getSnapshot(); } catch (e) { return undefined; } }
          : function () { return undefined; };
        var rawStore = react.useSyncExternalStore(sub, snap, snap);
        return function (selector) {
          var sel = selector || function (v) { return v; };
          return react.useMemo(function () {
            try { return sel(rawStore); } catch (e) { return undefined; }
          }, [rawStore]);
        };
      })();
      var actions = (storeInstance && storeInstance.actions) ? storeInstance.actions : {};
      // t（locale）：slotProps 可能含（宿主 shell 给 sidebar owner 的 props），
      // 也可能缺（本插件条目未声明 locale）。缺失时兜底 identity（t=(k)=>k，
      // 显示 key 原文，不崩溃）。WorkspaceBrowser 内 t("...") 大量调用，必须有函数。
      var t = (typeof slotProps.t === "function") ? slotProps.t : (typeof injected.t === "function") ? injected.t : function (k) { return k; };
      var all = Object.assign({}, slotProps, injected, {
        renderSlot: renderSlot,
        useStore: useStoreHook,
        actions: actions,
        t: t
      });
      var Comp = entry.component;
      if (typeof Comp !== "function") {
        return createElement("div", { className: "sg-root" },
          createElement("div", { className: "sg-empty" }, "原始视图：内置条目无组件"));
      }
      // 错误边界：组件崩溃时把报错 + props 诊断渲染到页面（不白屏）。
      // 用 class 组件实现 componentDidCatch（React 错误边界必须 class）。
      function BuiltinBoundaryClass() {
        this.state = { err: null };
      }
      BuiltinBoundaryClass.prototype = Object.create(react.Component.prototype);
      BuiltinBoundaryClass.prototype.constructor = BuiltinBoundaryClass;
      BuiltinBoundaryClass.prototype.isReactComponent = {};
      BuiltinBoundaryClass.prototype.componentDidCatch = function (e) {
        this.setState({ err: e });
      };
      BuiltinBoundaryClass.prototype.render = function () {
        if (this.state.err) {
          var diag = window.__sgPropsDiag || {};
          return createElement("div", { className: "sg-root", style: { padding: "8px", fontFamily: "monospace", fontSize: "11px", whiteSpace: "pre-wrap" } },
            "原始视图组件崩溃：", String((this.state.err && this.state.err.message) || this.state.err), createElement("br", null),
            "slotProps keys: ", JSON.stringify(diag.slotPropsKeys), createElement("br", null),
            "plain keys: ", JSON.stringify(diag.plainKeys), createElement("br", null),
            "sources: ", JSON.stringify(diag.sourceShapes || diag.sourceNames), createElement("br", null),
            "（F12 查 window.__sgPropsDiag）");
        }
        return this.props.children;
      };
      return createElement("div", { className: "sg-root" },
        createElement("div", { className: "sg-builtin-body" },
          createElement(BuiltinBoundaryClass, null, createElement(Comp, all))));
    }
    //#endregion

    //#region components (分组视图)
    function SessionRow(props) {
      var node = props.node;
      var s = node.session;
      var isCurrent = s.id === props.currentId;
      var canReorder = props.depth === 0;
      var indicator = "none";
      if (canReorder && props.draggingSessionId && props.draggingSessionId !== s.id) {
        var di = props.dropIndicator;
        if (di && di.sessionId === s.id) indicator = di.before ? "before" : "after";
      }
      var wrapCls = "sg-row-wrap" + (props.depth > 0 ? " sg-child" : "") + (props.dragging ? " dragging" : "") + (indicator !== "none" ? " sg-drop-" + indicator : "");
      var wrapProps = {
        className: wrapCls,
        draggable: true,
        onDragStart: function (e) {
          e.dataTransfer.setData(DND_MIME, s.id);
          e.dataTransfer.effectAllowed = "move";
          if (props.onRowDragStart) props.onRowDragStart(s.id);
        },
        onDragEnd: function () { if (props.onRowDragEnd) props.onRowDragEnd(); },
        "data-sg-session-id": s.id
      };
      if (canReorder) {
        wrapProps.onDragOver = function (e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          var r = e.currentTarget.getBoundingClientRect();
          var before = (e.clientY - r.top) < (r.height / 2);
          if (props.onRowDragOver) props.onRowDragOver(s.id, before);
        };
        wrapProps.onDrop = function (e) {
          e.preventDefault();
          e.stopPropagation();
          var r = e.currentTarget.getBoundingClientRect();
          var before = (e.clientY - r.top) < (r.height / 2);
          if (props.onRowDrop) props.onRowDrop(s.id, before, e);
        };
      }
      return createElement("div", wrapProps,
        createElement("button", {
          type: "button",
          className: "sg-row" + (isCurrent ? " current" : ""),
          onClick: function () { props.onOpen(s.id); },
          title: (s.cwd ? "cwd: " + s.cwd + "\n" : "") + (s.id || "")
        },
          s.running || s.completed
            ? createElement("span", { className: "sg-dot " + (s.running ? "running" : "completed") })
            : createElement("span", { className: "sg-dot", style: { background: "transparent" } }),
          createElement("span", { className: "sg-name" }, s.displayTitle || s.title || s.id),
          props.projBadge ? createElement("span", { className: "sg-proj" + (props.projBadge.custom ? " custom" : ""), title: props.projBadge.text }, props.projBadge.text) : null,
          createElement("span", { className: "sg-time" }, fmtTime(s.updatedAt)),
          createElement("span", { className: "sg-actions" },
            createElement("button", { type: "button", className: "sg-act", title: "重命名",
              onClick: function (e) { e.stopPropagation(); props.onRename(s); } }, "✎"),
            createElement("button", { type: "button", className: "sg-act", title: "分叉会话",
              onClick: function (e) { e.stopPropagation(); props.onFork(s); } }, "⑂"),
            createElement("button", { type: "button", className: "sg-act", title: "归档",
              onClick: function (e) { e.stopPropagation(); props.onArchive(s.id); } }, "⌫")
          )
        ),
        props.children && props.children.length > 0 ? props.children : null
      );
    }

    function RenameRow({ session, onCommit, onCancel }) {
      var [value, setValue] = useState(session.displayTitle || session.title || "");
      var inputRef = useRef(null);
      useEffect(function () { if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, []);
      return createElement("input", {
        ref: inputRef,
        className: "sg-rename",
        value: value,
        onChange: function (e) { setValue(e.target.value); },
        onKeyDown: function (e) {
          if (e.key === "Enter") onCommit(value);
          else if (e.key === "Escape") onCancel();
        },
        onBlur: function () { onCommit(value); }
      });
    }

    function GroupSection(props) {
      var group = props.group;
      var [renamingId, setRenamingId] = useState(props.renaming && props.renaming.groupKey === group.key ? props.renaming.sessionId : null);
      var label = groupLabelOf(group.key, props.customGroups);
      var pinned = props.pinnedMap[group.key] === true;
      var rows = [];
      for (var i = 0; i < group.sessions.length; i++) {
        (function () {
          var s = group.sessions[i];
          var kids = props.childrenOf.get(s.id) || [];
          var kidNodes = [];
          for (var k = 0; k < kids.length; k++) {
            var kd = kids[k];
            if (renamingId === kd.session.id) {
              kidNodes.push(createElement(RenameRow, { key: kd.session.id, session: kd.session,
                onCommit: function (v) { props.onRename(kd.session, v); setRenamingId(null); },
                onCancel: function () { setRenamingId(null); } }));
            } else {
              kidNodes.push(createElement(SessionRow, {
                key: kd.session.id, node: kd, currentId: props.currentId, depth: kd.depth + 1,
                onOpen: props.onOpen, onRename: props.onRename, onArchive: props.onArchive, onFork: props.onFork,
                projBadge: null,
                dragging: props.draggingSessionId === kd.session.id,
                onRowDragStart: props.onRowDragStart, onRowDragEnd: props.onRowDragEnd
              }));
            }
          }
          if (renamingId === s.id) {
            rows.push(createElement("div", { key: s.id, className: "sg-row-wrap" },
              createElement(RenameRow, { session: s,
                onCommit: function (v) { props.onRename(s, v); setRenamingId(null); },
                onCancel: function () { setRenamingId(null); } })));
          } else {
            var badgeText = props.showProjBadge ? projectBadgeText(s) : null;
            var isCustom = props.overrides && props.overrides[s.id];
            rows.push(createElement(SessionRow, {
              key: s.id, node: { session: s }, currentId: props.currentId, depth: 0,
              onOpen: props.onOpen, onRename: function (t) { setRenamingId(t.id); },
              onArchive: props.onArchive, onFork: props.onFork,
              projBadge: badgeText ? { text: badgeText, custom: !!isCustom } : null,
              dragging: props.draggingSessionId === s.id,
              onRowDragStart: props.onRowDragStart, onRowDragEnd: props.onRowDragEnd,
              dropIndicator: props.dropIndicator,
              onRowDragOver: props.onRowDragOver, onRowDrop: props.onRowDrop,
              draggingSessionId: props.draggingSessionId,
              children: kidNodes.length > 0 ? kidNodes : null
            }));
          }
        })();
      }
      return createElement("div", {
        className: "sg-group" + (props.dragOverKey === group.key ? " dropTarget" : ""),
        onDragOver: function (e) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; props.onGroupDragOver(group.key); },
        onDragEnter: function (e) { e.preventDefault(); props.onGroupDragEnter(group.key); },
        onDragLeave: function (e) {
          var related = e.relatedTarget;
          if (related && e.currentTarget.contains(related)) return;
          props.onGroupDragLeave(group.key, e);
        },
        onDrop: function (e) { e.preventDefault(); if (!e.defaultPrevented) props.onGroupDrop(group.key, e); },
        "data-sg-group": group.key
      },
        createElement("button", {
          type: "button",
          className: "sg-grouphead",
          onClick: function () { props.onToggle(group.key); },
          title: label + "（" + group.count + " 个会话）"
        },
          createElement("span", { className: "sg-caret" + (props.collapsedMap[group.key] ? "" : " open") }, "▶"),
          pinned ? createElement("span", { className: "sg-gpin", title: "已置顶" }, "📌") : null,
          createElement("span", { className: "sg-glabel" }, label),
          createElement("span", { className: "sg-gcount" }, String(group.count)),
          createElement("span", { className: "sg-gactions" },
            createElement("button", { type: "button", className: "sg-gact", title: pinned ? "取消置顶" : "置顶该组",
              onClick: function (e) { e.stopPropagation(); props.onPinGroup(group.key); } }, pinned ? "📌" : "☆"),
            createElement("button", { type: "button", className: "sg-gact", title: "重命名组",
              onClick: function (e) { e.stopPropagation(); props.onRenameGroup(group.key); } }, "✎"),
            group.key !== DEFAULT_GROUP ? createElement("button", { type: "button", className: "sg-gact", title: "删除组（会话回到按目录分组）",
              onClick: function (e) { e.stopPropagation(); props.onDeleteGroup(group.key); } }, "✕") : null
          )
        ),
        props.collapsedMap[group.key]
          ? null
          : [
            rows,
            groupCwdPath(group.key) ? createElement("button", {
              key: "__new__",
              type: "button",
              className: "sg-newin",
              title: "在 " + groupCwdPath(group.key) + " 下新建会话（会话将带该项目 cwd）",
              onClick: function () { props.onNewInGroup(group.key); }
            }, "＋ 在此组新建会话") : null
          ]
      );
    }
    //#endregion

    //#region grouped view
    function GroupedBrowser(props) {
      var useSessions = props.useSessions;
      var useWorkspaces = props.useWorkspaces;
      var sessionsApi = props.sessions;
      // 归档入口：apply(ctx) 捕获的 ctx.uiWorkspace（GroupedBrowser 只拿 slotProps，
      // 无 ctx 作用域；之前误用裸 ctx 导致 ReferenceError: ctx is not defined）。
      var uiWorkspaceApi = props.uiWorkspace;
      var list = useSessions(function (s) { return s; });
      var workspaces = useWorkspaces(function (s) { return s; });
      var [state, setState] = useState(function () { return initState(readState()); });
      var [query, setQuery] = useState("");
      var [renaming, setRenaming] = useState(null);
      var [draggingSessionId, setDraggingSessionId] = useState(null);
      var [dragOverKey, setDragOverKey] = useState(null);
      var [dropIndicator, setDropIndicator] = useState(null);
      ensureStyles();

      function persist(next) {
        writeState(next);
        setState(next);
      }
      function patch(partial) {
        persist(Object.assign({}, state, partial));
      }

      var currentId = list ? list.current : undefined;
      var grouped = useMemo(function () {
        try {
          var r = deriveGroupedSessions(list, workspaces, state.overrides, state.pinned);
          var order = state.order || {};
          r.groups.forEach(function (g) {
            g.sessions = sortGroupSessions(g.sessions, order[g.key]);
          });
          return r;
        } catch (err) {
          console.warn("[session-group] derive failed:", err);
          return { groups: [], childrenOf: new Map(), current: currentId };
        }
      }, [list, workspaces, state.overrides, state.pinned, state.order]);
      var groups = useMemo(function () {
        return filterSessions(grouped.groups, query);
      }, [grouped.groups, query]);

      function handleOpen(id) {
        try { if (sessionsApi && typeof sessionsApi.open === "function") sessionsApi.open(id); } catch (err) { console.warn("[session-group] open failed:", err); }
      }
      function handleArchive(id) {
        if (!window.confirm("归档会话？（归档后在原始视图/内置列表的归档区可恢复）")) return;
        try {
          // 真实归档 API 在 uiWorkspace.archiveSession(id)（内置列表走同一路径）。
          // uiWorkspace 由 apply(ctx) 捕获后经 props 传入（GroupedBrowser 无 ctx 作用域）。
          var ui = uiWorkspaceApi;
          var hasUi = !!(ui && typeof ui.archiveSession === "function");
          var hasSes = !!(sessionsApi && typeof sessionsApi.archiveSession === "function");
          console.info("[session-group] archive", id,
            "uiWorkspace=" + hasUi, "sessions.archiveSession=" + hasSes,
            "uiKeys=" + Object.keys(ui || {}).join(","));
          if (hasUi) {
            Promise.resolve(ui.archiveSession(id)).then(function () {
              console.info("[session-group] archive OK:", id);
            }).catch(function (r) { console.warn("[session-group] archive rejected:", r); });
          } else if (hasSes) {
            Promise.resolve(sessionsApi.archiveSession(id)).catch(function (r) { console.warn("[session-group] archive rejected:", r); });
          } else if (sessionsApi && typeof sessionsApi.archive === "function") {
            Promise.resolve(sessionsApi.archive(id)).catch(function (r) { console.warn("[session-group] archive rejected:", r); });
          } else {
            window.alert("归档失败：当前宿主未提供 uiWorkspace.archiveSession（F12 查 console）");
          }
        } catch (err) { console.warn("[session-group] archive failed:", err); window.alert("归档失败：" + (err && err.message ? err.message : err)); }
      }
      function handleFork(session) {
        try {
          if (sessionsApi && typeof sessionsApi.fork === "function") {
            var p = sessionsApi.fork({ sessionId: session.id, increaseTitle: true });
            if (p && typeof p.then === "function") p.then(function (childId) {
              if (childId && sessionsApi && typeof sessionsApi.open === "function") sessionsApi.open(childId);
            }).catch(function (r) { console.warn("[session-group] fork failed:", r); });
          } else console.warn("[session-group] sessions API 无 fork 方法，已跳过");
        } catch (err) { console.warn("[session-group] fork failed:", err); }
      }
      function handleRename(session, explicitValue) {
        var v;
        if (explicitValue !== undefined) {
          v = String(explicitValue || "").trim();
        } else {
          v = String(window.prompt("重命名会话：", session.displayTitle || session.title || "") || "").trim();
        }
        if (!v) return;
        try {
          if (sessionsApi && typeof sessionsApi.rename === "function") sessionsApi.rename(session.id, v).catch(function (r) { console.warn("[session-group] rename rejected:", r); });
          else if (sessionsApi && typeof sessionsApi.renameSession === "function") sessionsApi.renameSession(session.id, v).catch(function (r) { console.warn("[session-group] rename rejected:", r); });
          else console.warn("[session-group] sessions API 无 rename 方法，已跳过");
        } catch (err) { console.warn("[session-group] rename failed:", err); }
      }
      function handleToggle(key) {
        patch({ collapsed: toggleCollapsed(state.collapsed, key) });
      }
      function handlePinGroup(key) {
        var next = Object.assign({}, state.pinned);
        if (next[key]) delete next[key]; else next[key] = true;
        patch({ pinned: next });
      }
      function handleRenameGroup(key) {
        var cur = groupLabelOf(key, state.customGroups);
        var v = String(window.prompt("重命名分组：", cur) || "").trim();
        if (!v || v === cur) return;
        var next = Object.assign({}, state.customGroups);
        next[key] = { name: v };
        patch({ customGroups: next });
      }
      function handleDeleteGroup(key) {
        if (key === DEFAULT_GROUP) return;
        var affected = Object.keys(state.overrides).filter(function (id) { return state.overrides[id] === key; });
        var msg = key.indexOf("manual:") === 0
          ? "删除自定义组「" + groupLabelOf(key, state.customGroups) + "」？" + (affected.length ? affected.length + " 个会话将回到按目录分组。" : "")
          : "将组「" + groupLabelOf(key, state.customGroups) + "」恢复为按目录自动分组？组内被手动移入的会话将回到各自目录组。";
        if (!window.confirm(msg)) return;
        var nextOverrides = Object.assign({}, state.overrides);
        affected.forEach(function (id) { delete nextOverrides[id]; });
        var nextCustom = Object.assign({}, state.customGroups);
        delete nextCustom[key];
        patch({ overrides: nextOverrides, customGroups: nextCustom });
      }
      function handleNewGroup() {
        var v = String(window.prompt("新建分组（名称）：") || "").trim();
        if (!v) return;
        var exists = Object.keys(state.customGroups).some(function (k) {
          return k.indexOf("manual:") === 0 && state.customGroups[k].name === v;
        });
        if (exists) { alert("已存在同名分组「" + v + "」"); return; }
        var next = Object.assign({}, state.customGroups);
        next["manual:" + v] = { name: v, createdAt: Date.now() };
        patch({ customGroups: next });
      }
      function handleNewInGroup(key) {
        var path = groupCwdPath(key);
        if (!path) return;
        try {
          if (sessionsApi && typeof sessionsApi.create === "function") {
            var p = sessionsApi.create({ cwd: path });
            if (p && typeof p.then === "function") p.then(function (id) {
              if (id && sessionsApi && typeof sessionsApi.open === "function") sessionsApi.open(id);
            }).catch(function (r) {
              console.warn("[session-group] create failed:", r);
              window.alert("在 " + path + " 新建会话失败：" + (r && r.message ? r.message : r));
            });
          } else console.warn("[session-group] sessions API 无 create 方法，已跳过");
        } catch (err) {
          console.warn("[session-group] create failed:", err);
          window.alert("新建会话失败：" + (err && err.message ? err.message : err));
        }
      }

      function handleGroupDragOver(key) { setDragOverKey(key); }
      function handleGroupDragEnter(key) { setDragOverKey(key); }
      function handleGroupDragLeave(key) {
        setDragOverKey(function (cur) { return cur === key ? null : cur; });
      }
      /** 拖到组背景（非某会话行）→ 覆盖式换组（旧行为）。 */
      function handleGroupDrop(key, e) {
        e.preventDefault();
        var id = e.dataTransfer.getData(DND_MIME);
        setDragOverKey(null); setDropIndicator(null);
        if (!id) return;
        var byId = (list && list.byId) || {};
        var s = byId[id];
        if (!s) return;
        if (effectiveGroupKey(s, state.overrides) === key) return;
        var next = Object.assign({}, state.overrides);
        next[id] = key;
        patch({ overrides: next });
      }
      /** 拖到组内某会话行 → 定位排序（before/after），写入 order[groupKey]。 */
      function handleRowDragOver(targetId, before) {
        setDropIndicator({ sessionId: targetId, before: before });
      }
      function handleRowDrop(targetId, before, e) {
        e.preventDefault();
        var id = e.dataTransfer.getData(DND_MIME);
        var g = e.currentTarget && e.currentTarget.closest ? e.currentTarget.closest("[data-sg-group]") : null;
        var key = g ? g.getAttribute("data-sg-group") : null;
        setDragOverKey(null); setDropIndicator(null);
        if (!id || !key) return;
        if (id === targetId) return;
        var byId = (list && list.byId) || {};
        var s = byId[id];
        if (!s) return;
        var moved = effectiveGroupKey(s, state.overrides) !== key;
        var nextOverrides = Object.assign({}, state.overrides);
        if (moved) nextOverrides[id] = key;
        // 该组当前完整会话 id（含目标行）：从 grouped 取 + 确保 dragged 在内
        var g = null;
        for (var i = 0; i < grouped.groups.length; i++) { if (grouped.groups[i].key === key) { g = grouped.groups[i]; break; } }
        var ids = g ? g.sessions.map(function (x) { return x.id; }) : [];
        if (ids.indexOf(id) === -1) ids.push(id);
        ids = ids.filter(function (x) { return x !== id; });
        var ti = ids.indexOf(targetId);
        if (ti === -1) { /* 目标不在组内，退化为追加末尾 */ ids.push(id); }
        else ids.splice(before ? ti : ti + 1, 0, id);
        var nextOrder = Object.assign({}, state.order);
        nextOrder[key] = ids;
        patch({ overrides: nextOverrides, order: nextOrder });
      }

      var total = 0;
      for (var i = 0; i < grouped.groups.length; i++) total += grouped.groups[i].count;

      return createElement("div", { className: "sg-root" },
        createElement("div", { className: "sg-head" },
          createElement("div", { className: "sg-viewtoggle" },
            createElement("button", { type: "button", className: "active", title: "按项目分组视图（当前）" }, "分组"),
            createElement("button", { type: "button", title: "切换回 DSH 内置原生会话列表（搜索/新建/拖拽排序/工作区管理）",
              onClick: function () { setViewMode("builtin"); } }, "原始")
          ),
          createElement("input", {
            className: "sg-search",
            type: "text",
            placeholder: "搜索会话…",
            value: query,
            onChange: function (e) { setQuery(e.target.value); },
            title: "按标题过滤会话"
          }),
          createElement("span", { className: "sg-title" }, "")
        ),
        createElement("div", { className: "sg-body" },
          groups.length === 0 && !query
            ? createElement("div", { className: "sg-empty" }, (list && list.phase === "empty") ? "（无会话）" : "加载会话中…")
            : groups.length === 0 && query
              ? createElement("div", { className: "sg-empty" }, "无匹配「" + query + "」的会话")
              : groups.map(function (g) {
                return createElement(GroupSection, {
                  key: g.key,
                  group: g,
                  childrenOf: grouped.childrenOf,
                  currentId: currentId,
                  collapsedMap: state.collapsed,
                  pinnedMap: state.pinned,
                  customGroups: state.customGroups,
                  overrides: state.overrides,
                  onToggle: handleToggle,
                  onOpen: handleOpen,
                  onRename: function (s, v) { if (renaming) setRenaming(null); handleRename(s, v); },
                  onArchive: handleArchive,
                  onFork: handleFork,
                  onPinGroup: handlePinGroup,
                  onRenameGroup: handleRenameGroup,
                  onDeleteGroup: handleDeleteGroup,
                  onNewInGroup: handleNewInGroup,
                  renaming: renaming,
                  dragOverKey: dragOverKey,
                  onGroupDragOver: handleGroupDragOver,
                  onGroupDragEnter: handleGroupDragEnter,
                  onGroupDragLeave: handleGroupDragLeave,
                  onGroupDrop: handleGroupDrop,
                  draggingSessionId: draggingSessionId,
                  onRowDragStart: function (id) { setDraggingSessionId(id); },
                  onRowDragEnd: function () { setDraggingSessionId(null); setDragOverKey(null); setDropIndicator(null); },
                  dropIndicator: dropIndicator,
                  onRowDragOver: handleRowDragOver,
                  onRowDrop: handleRowDrop,
                  showProjBadge: true
                });
              }),
          createElement("button", { type: "button", className: "sg-addgroup", onClick: handleNewGroup }, "＋ 新建分组")
        ),
        createElement("div", { className: "sg-foot" },
          createElement("span", null, String(total) + " 个会话 · " + grouped.groups.length + " 组" + (query ? "（过滤 " + groups.length + " 组）" : "")),
          createElement("span", null, "拖拽会话：到组头/组背景=换组；到某会话行=排序定位")
        )
      );
    }
    /** When the plugin yields the sidebar to DSH's native browser, keep one
     *  unobtrusive control visible so the user can switch back to grouped mode. */
    function ViewModeReturn() {
      var mode = react.useSyncExternalStore(subscribeViewMode, getViewMode, getViewMode);
      if (mode !== "builtin") return null;
      return createElement("button", {
        type: "button",
        className: "sg-view-return",
        title: "切回按项目分组的会话列表",
        onClick: function () { setViewMode("grouped"); }
      }, "分组视图");
    }
    //#endregion

    function apply(ctx) {
      /**
       * The plugin shadows sidebar.workspaces only while grouped mode is active.
       * Switching to the native view disposes that shadow, letting DSH render
       * its real WorkspaceBrowser instead of trying to reconstruct its props.
       */
      ensureStyles();
      // 捕获 uiWorkspace 服务（archiveSession 入口）。ctx.<service> 受 inject 声明门控，
      // 本插件已声明 uiWorkspace（package.json dsh.client.inject + exports.inject）。
      // 必须在 apply 里拿 —— 组件只收 slotProps，拿不到 ctx。
      var uiWorkspaceApi = (ctx && typeof ctx.uiWorkspace === "object") ? ctx.uiWorkspace : null;
      if (!uiWorkspaceApi || typeof uiWorkspaceApi.archiveSession !== "function") {
        console.warn("[session-group] uiWorkspace 服务未注入（inject 声明未生效？），归档将不可用。ctx 有 uiWorkspace 键=" + !!(ctx && "uiWorkspace" in ctx));
      }

      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({
          name: "shell.overlay",
          id: "session-group-view-return",
          order: 50,
          label: "会话分组视图"
        }, function () {
          return createElement(ViewModeReturn);
        });
      });

      ctx.slots.inject("sidebar.workspaces", function () {
        var disposeRegistration = null;
        function syncRegistration() {
          var wantGrouped = getViewMode() === "grouped";
          if (wantGrouped && disposeRegistration === null) {
            disposeRegistration = ctx.slots.register({
          name: "sidebar.workspaces",
          id: "session-group",
          label: "按项目分组",
          // 内置 WorkspaceBrowser 条目在宿主 boot 时以 priority 0 注册（registered
          // by H5）。single 槽同 priority 重复注册会抛 "already has a registration
          // at priority 0"。本插件用 priority -1（比 0 更低 = "lowest renders"，
          // 本插件胜出、shadow 掉内置），内置条目（priority 0）仍留在 entries 里
          // 供原始视图 findBuiltinEntry 找到并渲染。
              priority: -1
            }, function (slotProps) {
              return createElement(GroupedBrowser, {
                useSessions: slotProps.useSessions,
                useWorkspaces: slotProps.useWorkspaces,
                sessions: ctx.sessions,
                uiWorkspace: uiWorkspaceApi
              });
            });
          } else if (!wantGrouped && disposeRegistration !== null) {
            var dispose = disposeRegistration;
            disposeRegistration = null;
            dispose();
          }
        }
        syncRegistration();
        var unsubscribe = subscribeViewMode(syncRegistration);
        return function () {
          unsubscribe();
          if (disposeRegistration !== null) {
            disposeRegistration();
            disposeRegistration = null;
          }
        };
      });
    }

    exports.apply = apply;
    // uiWorkspace = 归档入口（archiveSession）；ctx.<service> 访问受 inject 声明门控，
    // 不声明则 ctx.uiWorkspace 为 undefined（v1.1.0 漏声明导致归档静默失败）。
    exports.inject = ["slots", "sessions", "uiWorkspace"];
    // 纯函数导出，供宿主侧单测（node 环境无 window/document 时 require 本文件）
    exports.__test = {
      deriveGroupedSessions: deriveGroupedSessions,
      groupKeyOf: groupKeyOf,
      groupLabelOf: groupLabelOf,
      groupCwdPath: groupCwdPath,
      norm: norm,
      effectiveGroupKey: effectiveGroupKey,
      sortGroupSessions: sortGroupSessions,
      filterSessions: filterSessions,
      DEFAULT_GROUP: DEFAULT_GROUP,
      DND_MIME: DND_MIME,
      getViewMode: getViewMode,
      setViewMode: setViewMode
    };
    return module.exports;
  }
});
