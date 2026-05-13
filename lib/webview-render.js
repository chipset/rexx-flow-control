const { buildWebviewCsp, createNonce } = require("./shared");
const { sanitizeCss, serializeForScript, escapeHtml } = require("./webview-support");

const MODULE_HUES = [28, 215, 260, 175, 145, 95, 305, 340, 50, 5, 190, 120];

function normalizeModuleId(value, fallback) {
  const raw = String(value || fallback || "module").trim() || "module";
  return raw.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "module";
}

function classifyKind(kind) {
  if (kind === "entry" || kind === "function" || kind === "reference") {
    return "sync";
  }
  if (kind === "external-program" || kind === "tso-command") {
    return "external";
  }
  if (kind === "dynamic" || kind === "dynamic-call" || kind === "dynamic-jump") {
    return "dynamic";
  }
  return kind || "sync";
}

function graphToRexViewData(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const moduleByKey = new Map();

  const moduleForNode = (node) => {
    const label = node.fileLabel || node.fileId || node.kind || "current";
    const key = normalizeModuleId(label);
    if (!moduleByKey.has(key)) {
      moduleByKey.set(key, {
        id: key,
        label: String(label),
        file: node.fileLabel || node.fileUri || "",
        hue: MODULE_HUES[moduleByKey.size % MODULE_HUES.length]
      });
    }
    return key;
  };

  const FUNCTIONS = nodes.map((node) => {
    const metric = (graph.analysis?.metrics || []).find((item) => item.id === node.id);
    const calls = edges.filter((edge) => edge.from === node.id).map((edge) => edge.to);
    const flags = Array.isArray(node.flags) && node.flags.length ? ` Flags: ${node.flags.join(", ")}.` : "";
    const metricText = metric
      ? ` Complexity ${metric.cyclomaticComplexity}; fan-in ${metric.fanIn}; fan-out ${metric.fanOut}.`
      : "";
    return {
      id: String(node.id),
      name: String(node.label || node.id),
      module: moduleForNode(node),
      line: Number(node.line) || 1,
      kind: classifyKind(node.kind),
      sig: `${node.label || node.id} @ line ${Number(node.line) || 1}`,
      doc: `${node.kind || "node"}${metricText}${flags}`,
      fileUri: node.fileUri || "",
      calls
    };
  });

  const FN_BY_ID = Object.fromEntries(FUNCTIONS.map((fn) => [fn.id, fn]));
  const EDGES = [];
  const seenEdges = new Set();
  for (const edge of edges) {
    if (!FN_BY_ID[edge.from] || !FN_BY_ID[edge.to]) {
      continue;
    }
    const key = `${edge.from}\u0000${edge.to}`;
    if (seenEdges.has(key)) {
      continue;
    }
    seenEdges.add(key);
    EDGES.push({ from: String(edge.from), to: String(edge.to), type: String(edge.type || "calls") });
  }

  const CALL_COUNT = {};
  const IN_DEGREE = {};
  FUNCTIONS.forEach((fn) => {
    CALL_COUNT[fn.id] = 0;
    IN_DEGREE[fn.id] = 0;
  });
  EDGES.forEach((edge) => {
    CALL_COUNT[edge.to] = (CALL_COUNT[edge.to] || 0) + 1;
    IN_DEGREE[edge.to] = (IN_DEGREE[edge.to] || 0) + 1;
  });

  const MODULES = Array.from(moduleByKey.values());
  const MOD_BY_ID = Object.fromEntries(MODULES.map((mod) => [mod.id, mod]));
  return { MODULES, FUNCTIONS, FN_BY_ID, MOD_BY_ID, EDGES, CALL_COUNT, IN_DEGREE };
}

function renderGraphHtml(
  graph,
  fileName,
  customCss = "",
  scriptNonce = createNonce(),
  persistedState = {}
) {
  const rexData = graphToRexViewData(graph);
  const customCssBlock = customCss ? `\n<style id="user-css">\n${sanitizeCss(customCss)}\n</style>` : "";
  const graphJson = serializeForScript(graph || {});
  const rexJson = serializeForScript(rexData);
  const persistedJson = serializeForScript(persistedState || {});
  const title = escapeHtml(fileName || "REXX Control Flow");
  const appClass = "app";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${buildWebviewCsp(scriptNonce)}" />
  <title>REXX Control Flow</title>
  <style>
    :root {
      --bg: oklch(0.07 0.006 250);
      --canvas: oklch(0.10 0.008 250);
      --panel: rgba(18,18,22,.78);
      --panel-hi: rgba(28,28,34,.86);
      --border: rgba(255,255,255,.08);
      --border-hi: rgba(255,255,255,.13);
      --fg: #ebe9e2;
      --muted: rgba(235,232,225,.62);
      --soft: rgba(235,232,225,.38);
      --fill: rgba(255,255,255,.055);
      --fill-hi: rgba(255,255,255,.12);
      --accent: oklch(0.74 0.14 215);
    }
    * { box-sizing: border-box; }
    html, body, #app { margin: 0; width: 100%; height: 100%; overflow: hidden; }
    body {
      background: var(--bg);
      color: var(--fg);
      font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "SF Pro Text", sans-serif;
    }
    button, input, select { font: inherit; }
    .app {
      position: fixed;
      inset: 0;
      display: grid;
      grid-template-rows: 52px minmax(0, 1fr);
      background: var(--bg);
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 0 16px;
      border-bottom: .5px solid var(--border);
      background: var(--panel);
      backdrop-filter: blur(14px) saturate(140%);
      z-index: 20;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 220px;
    }
    .brand-mark {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      background: var(--accent);
      color: #0a0a0c;
      display: grid;
      place-items: center;
      font: 700 12px/1 "JetBrains Mono", ui-monospace, monospace;
    }
    .brand-title { font-weight: 650; font-size: 13px; }
    .brand-subtitle {
      color: var(--soft);
      font: 10.5px/1.3 "JetBrains Mono", ui-monospace, monospace;
      max-width: 360px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .toolbar-spacer { flex: 1; }
    .search {
      width: min(280px, 30vw);
      height: 30px;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 0 10px;
      border: .5px solid var(--border);
      border-radius: 8px;
      background: var(--fill);
    }
    .search input {
      width: 100%;
      min-width: 0;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--fg);
      font-size: 12px;
    }
    .segmented {
      display: inline-flex;
      gap: 2px;
      padding: 2px;
      border-radius: 8px;
      background: rgba(255,255,255,.07);
    }
    .segmented button {
      border: 0;
      border-radius: 6px;
      padding: 5px 11px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font-size: 11.5px;
    }
    .segmented button.active {
      background: var(--fill-hi);
      color: var(--fg);
      font-weight: 650;
      box-shadow: inset 0 0 0 .5px rgba(255,255,255,.08);
    }
    .workspace {
      min-height: 0;
      display: grid;
      grid-template-columns: 240px minmax(0, 1fr) 320px;
    }
    .sidebar, .inspector {
      min-height: 0;
      overflow: auto;
      background: var(--panel);
      backdrop-filter: blur(14px) saturate(140%);
    }
    .sidebar { border-right: .5px solid var(--border); padding: 10px 6px 12px; }
    .inspector { border-left: .5px solid var(--border); }
    .section-label {
      padding: 2px 10px 6px;
      color: var(--soft);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .06em;
      text-transform: uppercase;
      display: flex;
      justify-content: space-between;
    }
    .module-header, .fn-row, .rel-row {
      width: 100%;
      border: 0;
      text-align: left;
      background: transparent;
      color: var(--fg);
      cursor: pointer;
      border-radius: 6px;
    }
    .module-header {
      display: grid;
      grid-template-columns: 10px 10px minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
    }
    .module-dot, .rel-dot { width: 8px; height: 8px; border-radius: 2px; }
    .module-name, .fn-name, .rel-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: "JetBrains Mono", ui-monospace, monospace;
    }
    .module-name { font-size: 11.5px; font-weight: 550; }
    .count {
      color: var(--soft);
      font: 10px/1 "JetBrains Mono", ui-monospace, monospace;
    }
    .icon-button {
      border: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      width: 18px;
      height: 18px;
      padding: 0;
      border-radius: 4px;
    }
    .fn-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px;
      padding: 3px 8px 3px 30px;
      border-left: 2px solid transparent;
    }
    .fn-row:hover, .module-header:hover, .rel-row:hover { background: var(--fill); }
    .fn-row.selected { background: var(--fill); font-weight: 650; }
    .fn-line { color: var(--soft); font: 9.5px/1 "JetBrains Mono", ui-monospace, monospace; }
    .canvas {
      position: relative;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      cursor: grab;
      background:
        radial-gradient(ellipse 80% 60% at 50% 30%, oklch(0.165 0.012 250), transparent 70%),
        var(--canvas);
    }
    .canvas.panning { cursor: grabbing; }
    .grid {
      position: absolute;
      inset: 0;
      pointer-events: none;
      opacity: .7;
      background-image: radial-gradient(circle, rgba(255,255,255,.05) 1px, transparent 1px);
    }
    .graph-layer {
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: 0 0;
    }
    .world {
      position: absolute;
      left: 0;
      top: 0;
    }
    .edges {
      position: absolute;
      left: 0;
      top: 0;
      overflow: visible;
      pointer-events: none;
    }
    .node {
      position: absolute;
      width: 168px;
      height: 38px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 8px 0 10px;
      border: 0;
      border-left: 3px solid var(--accent);
      border-radius: 8px;
      background: oklch(0.23 0.008 250 / .96);
      color: var(--fg);
      cursor: pointer;
      user-select: none;
      box-shadow: inset 0 0 0 .5px rgba(255,255,255,.06), 0 1px 2px rgba(0,0,0,.35);
      font-variant-ligatures: none;
    }
    .node:hover, .node.highlight {
      box-shadow: inset 0 0 0 .5px rgba(255,255,255,.08), 0 8px 20px -10px var(--node-edge);
    }
      .node.selected {
        background: oklch(0.28 0.01 250);
        box-shadow: 0 0 0 1.5px var(--node-color), 0 10px 28px -10px var(--node-edge), inset 0 0 0 .5px rgba(255,255,255,.06);
      }
      .node.uncalled {
        border-left-color: oklch(0.68 0.22 27);
        background: linear-gradient(90deg, oklch(0.28 0.08 27 / .96), oklch(0.21 0.018 250 / .96));
        box-shadow: inset 0 0 0 .5px oklch(0.74 0.18 27 / .42), 0 8px 22px -14px oklch(0.68 0.22 27);
      }
      .node.uncalled .node-name {
        color: oklch(0.86 0.08 27);
      }
      .node.dim { opacity: .45; }
    .node.hidden { display: none; }
    .node-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: 650 12.5px/1 "JetBrains Mono", ui-monospace, monospace;
    }
    .node-line, .node-count {
      font: 10px/1 "JetBrains Mono", ui-monospace, monospace;
      color: var(--soft);
    }
    .node-count {
      min-width: 18px;
      height: 16px;
      padding: 3px 5px;
      border-radius: 999px;
      color: var(--node-color);
      background: var(--node-bg);
      font-weight: 700;
    }
    .collapse {
      border: 0;
      border-radius: 4px;
      width: 16px;
      height: 16px;
      padding: 0;
      cursor: pointer;
      background: rgba(255,255,255,.06);
      color: var(--node-color);
      font: 700 11px/1 "JetBrains Mono", ui-monospace, monospace;
    }
    .zoom {
      position: absolute;
      right: 16px;
      top: 16px;
      display: grid;
      gap: 4px;
      z-index: 8;
    }
    .zoom button, .zoom-value {
      width: 30px;
      min-height: 28px;
      border: .5px solid var(--border-hi);
      border-radius: 6px;
      background: rgba(20,20,24,.78);
      color: rgba(235,232,225,.85);
      backdrop-filter: blur(8px);
      cursor: pointer;
      font-weight: 700;
    }
    .zoom-value {
      width: auto;
      padding: 4px 6px;
      color: var(--muted);
      font: 10px/1 "JetBrains Mono", ui-monospace, monospace;
      text-align: center;
      cursor: default;
    }
    .floating {
      position: absolute;
      bottom: 16px;
      z-index: 7;
      background: rgba(18,18,22,.82);
      border: .5px solid var(--border-hi);
      border-radius: 8px;
      backdrop-filter: blur(10px);
      box-shadow: 0 8px 24px -10px rgba(0,0,0,.6);
    }
    .legend { left: 16px; width: 166px; overflow: hidden; }
    .legend-title {
      width: 100%;
      border: 0;
      background: transparent;
      color: var(--soft);
      padding: 7px 10px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      font: 700 9.5px/1 ui-sans-serif, system-ui;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
      .legend-body { padding: 0 10px 10px; display: grid; gap: 4px; }
      .legend-row { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 10.5px; }
      .legend-uncalled {
        background: oklch(0.68 0.22 27);
        box-shadow: 0 0 0 1px oklch(0.74 0.18 27 / .42);
      }
      .minimap { right: 16px; width: 200px; height: 110px; cursor: crosshair; overflow: hidden; }
    .inspector-head { padding: 14px 18px 12px; border-bottom: .5px solid var(--border); }
    .pill {
      display: inline-flex;
      max-width: 170px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 2px 7px;
      border-radius: 4px;
      font: 700 10px/1.4 "JetBrains Mono", ui-monospace, monospace;
      background: var(--fill);
      color: var(--muted);
    }
    .inspector h2 {
      margin: 8px 0 0;
      color: var(--fg);
      font: 650 18px/1.25 "JetBrains Mono", ui-monospace, monospace;
    }
    .sig {
      display: block;
      margin-top: 8px;
      padding: 8px 10px;
      border: .5px solid var(--border);
      border-radius: 6px;
      background: var(--fill);
      color: var(--muted);
      white-space: pre-wrap;
      word-break: break-word;
      font: 11px/1.5 "JetBrains Mono", ui-monospace, monospace;
    }
    .inspector-body { padding: 14px 18px; }
    .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 0 0 18px; }
    .metric { padding: 8px 10px; border: .5px solid var(--border); border-radius: 6px; background: var(--fill); }
    .metric strong { display: block; font: 650 18px/1 "JetBrains Mono", ui-monospace, monospace; }
    .metric span { display: block; margin-top: 4px; color: var(--soft); font-size: 10px; }
    .rel-title {
      margin: 0 0 8px;
      color: var(--soft);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    .rel-row { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 5px 8px; }
    .context-menu {
      position: fixed;
      z-index: 50;
      min-width: 170px;
      padding: 5px;
      display: none;
      border: .5px solid var(--border-hi);
      border-radius: 8px;
      background: rgba(18,18,22,.96);
      box-shadow: 0 18px 38px rgba(0,0,0,.36);
    }
    .context-menu.open { display: grid; }
    .context-menu button {
      border: 0;
      border-radius: 5px;
      padding: 7px 9px;
      background: transparent;
      color: var(--fg);
      text-align: left;
      cursor: pointer;
      font-size: 12px;
    }
    .context-menu button:hover { background: var(--fill-hi); }
    @media (max-width: 940px) {
      .workspace { grid-template-columns: 1fr; }
      .sidebar, .inspector { display: none; }
      .search { width: 38vw; }
      .brand { min-width: 160px; }
    }
  </style>${customCssBlock}
</head>
<body>
  <div id="app" class="${appClass}" data-title="${title}"></div>
  <script nonce="${scriptNonce}">
      const vscode = acquireVsCodeApi();
      const graphData = ${graphJson};
      const REX = ${rexJson};
      const persisted = ${persistedJson};
      const longestFunctionName = Math.max(0, ...REX.FUNCTIONS.map((fn) => String(fn.name || '').length));
      const NODE_W = Math.max(220, longestFunctionName * 8 + 108);
      const NODE_H = 38;
      const nodePositions = new Map(Object.entries(persisted.nodePositions || {}).filter(([id, pos]) => REX.FN_BY_ID[id] && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y))).map(([id, pos]) => [id, { x: Math.round(Number(pos.x)), y: Math.round(Number(pos.y)) }]));
      const app = document.getElementById('app');
      const state = {
        layout: 'tree',
        selectedId: REX.FN_BY_ID.MAIN ? 'MAIN' : (REX.FUNCTIONS[0] && REX.FUNCTIONS[0].id) || null,
        hoverId: null,
        search: '',
        movementEnabled: false,
        nodePositions,
        collapsed: new Set(),
        visibleModules: new Set(REX.MODULES.map((mod) => mod.id)),
        transform: { scale: 1, x: 0, y: 0 },
        legendOpen: true,
      moduleOpen: new Set(REX.MODULES.map((mod) => mod.id))
    };
    let layoutData = null;
    let canvas = null;
    let graphLayer = null;
    let world = null;
    let edgesSvg = null;
    let grid = null;
      let minimap = null;
      let drag = null;
      let nodeDrag = null;
      let suppressNodeClickId = null;

    function el(tag, attrs, children) {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs || {})) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'style') Object.assign(node.style, value);
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : String(value));
      }
      for (const child of children || []) {
        if (child != null) node.append(child);
      }
      return node;
    }

    function svgEl(tag, attrs) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [key, value] of Object.entries(attrs || {})) {
        node.setAttribute(key, String(value));
      }
      return node;
    }

    function moduleColor(mod, alpha = 1, kind = 'fg') {
      const h = mod.hue;
      if (kind === 'bg') return 'oklch(0.32 0.07 ' + h + ' / ' + alpha + ')';
      if (kind === 'edge') return 'oklch(0.68 0.12 ' + h + ' / ' + alpha + ')';
      return 'oklch(0.74 0.14 ' + h + ' / ' + alpha + ')';
    }

    function buildAdjacency() {
      const out = {}, inn = {};
      REX.FUNCTIONS.forEach((fn) => { out[fn.id] = []; inn[fn.id] = []; });
      REX.EDGES.forEach((edge) => {
        if (out[edge.from] && inn[edge.to]) {
          out[edge.from].push(edge.to);
          inn[edge.to].push(edge.from);
        }
      });
      return { out, inn };
    }

    function rankedLayout() {
      const adj = buildAdjacency();
      const indeg = {};
      REX.FUNCTIONS.forEach((fn) => { indeg[fn.id] = adj.inn[fn.id].length; });
      const queue = REX.FUNCTIONS.filter((fn) => indeg[fn.id] === 0).map((fn) => fn.id);
      if (!queue.length && REX.FUNCTIONS[0]) queue.push(REX.FUNCTIONS[0].id);
      const order = [];
      while (queue.length) {
        const id = queue.shift();
        if (order.includes(id)) continue;
        order.push(id);
        adj.out[id].forEach((child) => {
          indeg[child] -= 1;
          if (indeg[child] <= 0) queue.push(child);
        });
      }
      REX.FUNCTIONS.forEach((fn) => { if (!order.includes(fn.id)) order.push(fn.id); });
      const rank = {};
      order.forEach((id) => {
        const parents = adj.inn[id] || [];
        rank[id] = parents.length ? 1 + Math.max(...parents.map((p) => rank[p] || 0)) : 0;
      });
      const ranks = Array.from({ length: Math.max(0, ...Object.values(rank)) + 1 }, () => []);
      Object.entries(rank).forEach(([id, r]) => ranks[r].push(id));
      const idxIn = {};
      ranks.forEach((layer) => layer.forEach((id, i) => { idxIn[id] = i; }));
      for (let r = 1; r < ranks.length; r += 1) {
        ranks[r].sort((a, b) => {
          const score = (id) => {
            const ps = adj.inn[id] || [];
            return ps.length ? ps.reduce((sum, p) => sum + (idxIn[p] || 0), 0) / ps.length : idxIn[id];
          };
          const diff = score(a) - score(b);
          if (diff) return diff;
          return REX.FN_BY_ID[a].name.localeCompare(REX.FN_BY_ID[b].name);
        });
        ranks[r].forEach((id, i) => { idxIn[id] = i; });
      }
      return ranks;
    }

      function computeLayout() {
        const densityScale = 1;
      const ranks = rankedLayout();
      const positions = {};
      if (state.layout === 'layered') {
        const colGap = 22 * densityScale;
        const rowGap = 110 * densityScale;
        const maxCols = Math.max(1, ...ranks.map((rank) => rank.length));
        const layerW = (rows) => rows * NODE_W + Math.max(0, rows - 1) * colGap;
        const totalW = layerW(maxCols);
        ranks.forEach((layer, row) => {
          const xStart = (totalW - layerW(layer.length)) / 2;
          layer.forEach((id, col) => {
            positions[id] = { x: xStart + col * (NODE_W + colGap), y: 32 + row * (NODE_H + rowGap) };
          });
        });
        return { positions, bounds: { w: totalW + 64, h: 32 + ranks.length * (NODE_H + rowGap) }, ranks };
      }
      if (state.layout === 'radial') {
        const ringStep = 158 * densityScale;
        const angle = {};
        const TAU = Math.PI * 2;
        const adj = buildAdjacency();
        ranks.forEach((layer, rankIndex) => {
          if (rankIndex === 0 && layer.length === 1) {
            angle[layer[0]] = 0;
            positions[layer[0]] = { x: 0, y: 0 };
            return;
          }
          const radius = Math.max(.4, rankIndex) * ringStep;
          layer.forEach((id, i) => {
            const parents = (adj.inn[id] || []).filter((p) => angle[p] != null);
            const baseAngle = parents.length
              ? Math.atan2(parents.reduce((sum, p) => sum + Math.sin(angle[p]), 0), parents.reduce((sum, p) => sum + Math.cos(angle[p]), 0))
              : 0;
            const a = baseAngle + (i / Math.max(1, layer.length)) * TAU;
            angle[id] = a;
            positions[id] = { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
          });
        });
        const maxR = Math.max(1, ranks.length - 1) * ringStep + NODE_W;
        const off = maxR + 60;
        Object.values(positions).forEach((pos) => { pos.x += off; pos.y += off; });
        return { positions, bounds: { w: off * 2, h: off * 2 }, ranks };
      }
        const colGap = 96 * densityScale;
        const rowGap = 18 * densityScale;
        const maxRows = Math.max(1, ...ranks.map((rank) => rank.length));
      const colHeight = (rows) => rows * NODE_H + Math.max(0, rows - 1) * rowGap;
      const totalH = colHeight(maxRows);
      ranks.forEach((layer, col) => {
        const yStart = (totalH - colHeight(layer.length)) / 2;
        layer.forEach((id, row) => {
          positions[id] = { x: 32 + col * (NODE_W + colGap), y: yStart + row * (NODE_H + rowGap) };
        });
        });
        return { positions, bounds: { w: 32 + ranks.length * (NODE_W + colGap), h: totalH + 64 }, ranks };
      }

      function applySavedNodePositions(layout) {
        if (!layout || !layout.positions) return layout;
        for (const [id, pos] of state.nodePositions.entries()) {
          if (layout.positions[id]) {
            layout.positions[id] = { x: pos.x, y: pos.y };
          }
        }
        layout.bounds = computeLayoutBounds(layout.positions, layout.bounds);
        return layout;
      }

      function computeLayoutBounds(positions, fallback) {
        const values = Object.values(positions || {});
        if (!values.length) return fallback || { w: 1, h: 1 };
        const minX = Math.min(0, ...values.map((pos) => pos.x));
        const minY = Math.min(0, ...values.map((pos) => pos.y));
        const maxX = Math.max(...values.map((pos) => pos.x + NODE_W));
        const maxY = Math.max(...values.map((pos) => pos.y + NODE_H));
        const shiftX = minX < 0 ? Math.abs(minX) + 32 : 0;
        const shiftY = minY < 0 ? Math.abs(minY) + 32 : 0;
        if (shiftX || shiftY) {
          for (const pos of values) {
            pos.x += shiftX;
            pos.y += shiftY;
          }
          for (const [id, pos] of state.nodePositions.entries()) {
            state.nodePositions.set(id, { x: pos.x + shiftX, y: pos.y + shiftY });
          }
        }
        return {
          w: Math.max((fallback && fallback.w) || 1, maxX + shiftX + 64),
          h: Math.max((fallback && fallback.h) || 1, maxY + shiftY + 64)
        };
      }

      function persistGraphState() {
        const statePayload = {
          nodePositions: Object.fromEntries(state.nodePositions),
          pinnedNodeIds: Array.from(state.nodePositions.keys())
        };
        vscode.setState(statePayload);
        vscode.postMessage({ type: 'persistUiState', state: statePayload });
      }

      function finishNodeDrag() {
        if (!nodeDrag) return;
        const finished = nodeDrag;
        nodeDrag = null;
        if (finished.moved) {
          suppressNodeClickId = finished.id;
          setTimeout(() => { if (suppressNodeClickId === finished.id) suppressNodeClickId = null; }, 0);
          persistGraphState();
          return;
        }
        persistGraphState();
        setSelected(finished.id);
      }

      function resetGraphView() {
        state.nodePositions.clear();
        state.movementEnabled = false;
        nodeDrag = null;
        layoutData = applySavedNodePositions(computeLayout());
        persistGraphState();
        render(true);
      }

    function visibleSet() {
      const roots = REX.FUNCTIONS.filter((fn) => (REX.IN_DEGREE[fn.id] || 0) === 0).map((fn) => fn.id);
      if (!roots.length && REX.FUNCTIONS[0]) roots.push(REX.FUNCTIONS[0].id);
      const visible = new Set();
      const queue = roots.slice();
      while (queue.length) {
        const id = queue.shift();
        if (visible.has(id)) continue;
        visible.add(id);
        if (state.collapsed.has(id)) continue;
        (REX.FN_BY_ID[id]?.calls || []).forEach((child) => queue.push(child));
      }
      return visible;
    }

    function highlightSet() {
      const focus = state.hoverId || state.selectedId;
      if (!focus) return null;
      const set = new Set([focus]);
      const callers = {};
      REX.FUNCTIONS.forEach((fn) => { callers[fn.id] = []; });
      REX.EDGES.forEach((edge) => callers[edge.to]?.push(edge.from));
      const walk = (ids, next) => {
        const queue = ids.slice();
        while (queue.length) {
          const id = queue.shift();
          next(id).forEach((child) => {
            if (!set.has(child)) {
              set.add(child);
              queue.push(child);
            }
          });
        }
      };
      walk([focus], (id) => callers[id] || []);
      walk([focus], (id) => REX.FN_BY_ID[id]?.calls || []);
      return set;
    }

    function searchSet() {
      const q = state.search.trim().toLowerCase();
      if (!q) return null;
      return new Set(REX.FUNCTIONS.filter((fn) => fn.name.toLowerCase().includes(q) || fn.id.toLowerCase().includes(q)).map((fn) => fn.id));
    }

    function edgePath(from, to) {
      if (state.layout === 'layered') {
        const sx = from.x + NODE_W / 2, sy = from.y + NODE_H;
        const tx = to.x + NODE_W / 2, ty = to.y;
        const dy = Math.max(40, (ty - sy) * .55);
        return 'M' + sx + ',' + sy + ' C' + sx + ',' + (sy + dy) + ' ' + tx + ',' + (ty - dy) + ' ' + tx + ',' + ty;
      }
      if (state.layout === 'radial') {
        const fc = { x: from.x + NODE_W / 2, y: from.y + NODE_H / 2 };
        const tc = { x: to.x + NODE_W / 2, y: to.y + NODE_H / 2 };
        const dx = tc.x - fc.x;
        const dy = tc.y - fc.y;
        const horizontal = Math.abs(dx) >= Math.abs(dy);
        const sx = horizontal ? from.x + (dx >= 0 ? NODE_W : 0) : fc.x;
        const sy = horizontal ? fc.y : from.y + (dy >= 0 ? NODE_H : 0);
        const tx = horizontal ? to.x + (dx >= 0 ? 0 : NODE_W) : tc.x;
        const ty = horizontal ? tc.y : to.y + (dy >= 0 ? 0 : NODE_H);
        const bend = Math.max(44, Math.hypot(dx, dy) * .34);
        const c1x = horizontal ? sx + Math.sign(dx || 1) * bend : sx;
        const c1y = horizontal ? sy : sy + Math.sign(dy || 1) * bend;
        const c2x = horizontal ? tx - Math.sign(dx || 1) * bend : tx;
        const c2y = horizontal ? ty : ty - Math.sign(dy || 1) * bend;
        return 'M' + sx + ',' + sy + ' C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + tx + ',' + ty;
      }
      const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2;
      const x2 = to.x, y2 = to.y + NODE_H / 2;
      const dx = Math.max(40, (x2 - x1) * .55);
      return 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2;
    }

    function fitGraph() {
      if (!canvas || !layoutData) return;
      const rect = canvas.getBoundingClientRect();
      const pad = 48;
      const sx = (rect.width - pad * 2) / Math.max(1, layoutData.bounds.w);
      const sy = (rect.height - pad * 2) / Math.max(1, layoutData.bounds.h);
      const scale = Math.max(.42, Math.min(1.1, Math.min(sx, sy)));
      state.transform = {
        scale,
        x: (rect.width - layoutData.bounds.w * scale) / 2,
        y: (rect.height - layoutData.bounds.h * scale) / 2
      };
      applyTransform();
    }

    function applyTransform() {
      if (!graphLayer) return;
      const t = 'translate(' + state.transform.x + 'px,' + state.transform.y + 'px) scale(' + state.transform.scale + ')';
      graphLayer.style.transform = t;
      grid.style.backgroundSize = (24 * state.transform.scale) + 'px ' + (24 * state.transform.scale) + 'px';
      grid.style.backgroundPosition = state.transform.x + 'px ' + state.transform.y + 'px';
      const zoomValue = document.getElementById('zoomValue');
      if (zoomValue) zoomValue.textContent = Math.round(state.transform.scale * 100) + '%';
      renderMinimap();
    }

      function setSelected(id) {
        state.selectedId = id;
        const fn = id ? REX.FN_BY_ID[id] : null;
        if (fn) {
          state.moduleOpen.add(fn.module);
          state.visibleModules.add(fn.module);
        }
        render();
        requestAnimationFrame(() => {
          document.querySelector('[data-fn-row-id="' + cssEscape(id) + '"]')?.scrollIntoView({ block: 'nearest' });
        });
      }

      function cssEscape(value) {
        return String(value || '').replace(/["\\\\]/g, '\\\\$&');
      }

    function renderToolbar(root) {
      const visible = visibleSet();
      const shownNodes = REX.FUNCTIONS.filter((fn) => visible.has(fn.id) && state.visibleModules.has(fn.module)).length;
      const toolbar = el('div', { class: 'toolbar' });
      toolbar.append(
        el('div', { class: 'brand' }, [
          el('div', { class: 'brand-mark', text: 'R' }),
          el('div', {}, [
            el('div', { class: 'brand-title', text: 'REXX Call Graph' }),
            el('div', { class: 'brand-subtitle', text: '${title} · ' + shownNodes + '/' + REX.FUNCTIONS.length + ' nodes' })
          ])
        ]),
        el('div', { class: 'toolbar-spacer' }),
        el('label', { class: 'search' }, [
          el('span', { text: '⌕', style: { color: 'var(--soft)' } }),
          el('input', {
            value: state.search,
            placeholder: 'Search functions...',
            oninput: (event) => { state.search = event.target.value; renderGraphOnly(); }
          })
        ]),
        segmented(['tree', 'layered', 'radial'], state.layout, (value) => { state.layout = value; render(true); })
      );
      root.append(toolbar);
    }

    function segmented(values, selected, onSelect) {
      return el('div', { class: 'segmented' }, values.map((value) => el('button', {
        class: value === selected ? 'active' : '',
        type: 'button',
        text: value[0].toUpperCase() + value.slice(1),
        onclick: () => onSelect(value)
      })));
    }

    function renderSidebar(root) {
      const sidebar = el('aside', { class: 'sidebar' });
      sidebar.append(el('div', { class: 'section-label' }, [
        el('span', { text: 'Modules' }),
        el('button', {
          class: 'icon-button',
          title: 'Show all modules',
          text: '↺',
          onclick: () => { state.visibleModules = new Set(REX.MODULES.map((mod) => mod.id)); render(); }
        })
      ]));
      REX.MODULES.forEach((mod) => {
        const fns = REX.FUNCTIONS.filter((fn) => fn.module === mod.id).sort((a, b) => a.line - b.line);
        const visible = state.visibleModules.has(mod.id);
        const open = state.moduleOpen.has(mod.id);
        sidebar.append(el('button', {
          class: 'module-header',
          type: 'button',
          ondblclick: (event) => { event.preventDefault(); state.visibleModules = new Set([mod.id]); render(); },
          onclick: () => {
            open ? state.moduleOpen.delete(mod.id) : state.moduleOpen.add(mod.id);
            render();
          }
        }, [
          el('span', { class: 'count', text: open ? '▾' : '▸' }),
          el('span', { class: 'module-dot', style: { background: moduleColor(mod) } }),
          el('span', { class: 'module-name', text: mod.label, style: { opacity: visible ? 1 : .45 } }),
          el('span', { class: 'count', text: fns.length }),
          el('span', { class: 'count', text: visible ? '◉' : '○', onclick: (event) => {
            event.stopPropagation();
            visible ? state.visibleModules.delete(mod.id) : state.visibleModules.add(mod.id);
            render();
          } })
        ]));
        if (open) {
            fns.forEach((fn) => sidebar.append(el('button', {
              class: 'fn-row' + (state.selectedId === fn.id ? ' selected' : ''),
              type: 'button',
              'data-fn-row-id': fn.id,
              onmouseenter: () => { state.hoverId = fn.id; renderGraphOnly(); },
              onmouseleave: () => { state.hoverId = null; renderGraphOnly(); },
              onclick: () => setSelected(fn.id)
          }, [
            el('span', { class: 'fn-name', text: fn.name }),
            el('span', { class: 'fn-line', text: fn.line })
          ])));
        }
      });
      root.append(sidebar);
    }

    function renderGraph(root, shouldFit) {
      const wrap = el('main', { class: 'canvas', id: 'canvasWrap' });
      canvas = wrap;
      grid = el('div', { class: 'grid' });
      graphLayer = el('div', { class: 'graph-layer', style: { width: layoutData.bounds.w + 'px', height: layoutData.bounds.h + 'px' } });
      edgesSvg = svgEl('svg', { class: 'edges', width: layoutData.bounds.w, height: layoutData.bounds.h, viewBox: '0 0 ' + layoutData.bounds.w + ' ' + layoutData.bounds.h });
      world = el('div', { class: 'world', style: { width: layoutData.bounds.w + 'px', height: layoutData.bounds.h + 'px' } });
      graphLayer.append(edgesSvg, world);
      wrap.append(grid, graphLayer);

      wrap.addEventListener('wheel', (event) => {
        event.preventDefault();
        const rect = wrap.getBoundingClientRect();
        const mx = event.clientX - rect.left;
        const my = event.clientY - rect.top;
        const next = Math.min(2.4, Math.max(.25, state.transform.scale * (1 - event.deltaY * .0015)));
        const ratio = next / state.transform.scale;
        state.transform = { scale: next, x: mx - (mx - state.transform.x) * ratio, y: my - (my - state.transform.y) * ratio };
        applyTransform();
      }, { passive: false });
      wrap.addEventListener('mousedown', (event) => {
        if (event.button !== 0 || event.target.closest('.node')) return;
        drag = { x: event.clientX, y: event.clientY, t: { ...state.transform } };
        wrap.classList.add('panning');
      });
      wrap.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openContextMenu(event.clientX, event.clientY);
      });

      renderGraphOnly();
      renderZoom(wrap);
      renderLegend(wrap);
      minimap = el('div', { class: 'floating minimap', id: 'minimap' });
      wrap.append(minimap);
      root.append(wrap);
      applyTransform();
      if (shouldFit) requestAnimationFrame(fitGraph);
    }

      function renderGraphOnly() {
        if (!world || !edgesSvg) return;
      world.textContent = '';
      while (edgesSvg.firstChild) edgesSvg.removeChild(edgesSvg.firstChild);
      const visible = visibleSet();
      const highlights = highlightSet();
      const matches = searchSet();
      REX.EDGES.forEach((edge) => {
        if (!visible.has(edge.from) || !visible.has(edge.to)) return;
        const from = layoutData.positions[edge.from];
        const to = layoutData.positions[edge.to];
        if (!from || !to) return;
        const fromFn = REX.FN_BY_ID[edge.from];
        const toFn = REX.FN_BY_ID[edge.to];
        const hl = highlights && highlights.has(edge.from) && highlights.has(edge.to);
        const dim = !state.visibleModules.has(fromFn.module) || !state.visibleModules.has(toFn.module) || (highlights && !hl) || (matches && !matches.has(edge.from) && !matches.has(edge.to));
        const mod = REX.MOD_BY_ID[fromFn.module];
        const path = svgEl('path', {
          d: edgePath(from, to),
          fill: 'none',
          stroke: 'oklch(0.72 0.11 ' + mod.hue + ' / ' + (hl ? .95 : dim ? .06 : .28) + ')',
          'stroke-width': Math.min(4, .6 + Math.log2(1 + (REX.CALL_COUNT[edge.to] || 0)) * .5) * (hl ? 1.6 : 1),
          'stroke-linecap': 'round'
        });
        edgesSvg.append(path);
      });
      REX.FUNCTIONS.forEach((fn) => {
        const pos = layoutData.positions[fn.id];
        if (!pos) return;
        const mod = REX.MOD_BY_ID[fn.module];
          const hidden = !visible.has(fn.id);
          const hl = highlights && highlights.has(fn.id);
          const dim = !state.visibleModules.has(fn.module) || (matches && !matches.has(fn.id)) || (highlights && !hl);
          const uncalled = !['MAIN', 'WORKSPACE'].includes(fn.id) && (REX.IN_DEGREE[fn.id] || 0) === 0;
          const node = el('div', {
            class: 'node' + (state.selectedId === fn.id ? ' selected' : '') + (hl && state.selectedId !== fn.id ? ' highlight' : '') + (uncalled ? ' uncalled' : '') + (dim ? ' dim' : '') + (hidden ? ' hidden' : ''),
            role: 'button',
            tabindex: 0,
          title: fn.sig,
          style: {
            left: pos.x + 'px',
            top: pos.y + 'px',
            width: NODE_W + 'px',
            '--node-color': moduleColor(mod),
            '--node-bg': moduleColor(mod, .55, 'bg'),
            '--node-edge': moduleColor(mod, .85, 'edge'),
            borderLeftColor: moduleColor(mod, dim ? .35 : 1)
            },
            onmouseenter: () => { state.hoverId = fn.id; },
            onmouseleave: () => { state.hoverId = null; },
            onmousedown: (event) => {
              if (event.button !== 0 || event.target.closest('.collapse')) return;
              event.preventDefault();
              event.stopPropagation();
              if (!state.movementEnabled) {
                setSelected(fn.id);
                return;
              }
              nodeDrag = { id: fn.id, x: event.clientX, y: event.clientY, start: { ...pos }, moved: false };
            },
            onclick: (event) => {
              event.stopPropagation();
              if (suppressNodeClickId === fn.id) return;
              setSelected(fn.id);
            },
            onkeydown: (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              event.stopPropagation();
              setSelected(fn.id);
            }
          }, [
          el('span', { class: 'node-name', text: fn.name }),
          el('span', { class: 'node-line', text: ':' + fn.line })
        ]);
          const count = REX.CALL_COUNT[fn.id] || 0;
          if (uncalled) node.append(el('span', { class: 'node-count', title: 'Not called by another node', text: '!' }));
          if (count > 0) node.append(el('span', { class: 'node-count', text: 'x' + count }));
        if (fn.calls.length) {
          node.append(el('button', {
            class: 'collapse',
            type: 'button',
            title: state.collapsed.has(fn.id) ? 'Expand subtree' : 'Collapse subtree',
            text: state.collapsed.has(fn.id) ? '+' : '-',
            onclick: (event) => {
              event.stopPropagation();
              state.collapsed.has(fn.id) ? state.collapsed.delete(fn.id) : state.collapsed.add(fn.id);
              render();
            }
          }));
        }
        world.append(node);
      });
      renderMinimap();
    }

    function renderZoom(root) {
      const zoom = el('div', { class: 'zoom' }, [
        el('button', { type: 'button', text: '+', onclick: (event) => { event.stopPropagation(); state.transform.scale = Math.min(2.4, state.transform.scale * 1.2); applyTransform(); } }),
        el('button', { type: 'button', text: '-', onclick: (event) => { event.stopPropagation(); state.transform.scale = Math.max(.25, state.transform.scale / 1.2); applyTransform(); } }),
        el('button', { type: 'button', text: '⤢', title: 'Fit graph', onclick: (event) => { event.stopPropagation(); fitGraph(); } }),
        el('div', { class: 'zoom-value', id: 'zoomValue', text: '100%' })
      ]);
      root.append(zoom);
    }

      function renderLegend(root) {
        const hasUncalled = REX.FUNCTIONS.some((fn) => !['MAIN', 'WORKSPACE'].includes(fn.id) && (REX.IN_DEGREE[fn.id] || 0) === 0);
        const legend = el('div', { class: 'floating legend' }, [
          el('button', { class: 'legend-title', type: 'button', onclick: () => { state.legendOpen = !state.legendOpen; render(); } }, [
          el('span', { text: 'Legend' }),
          el('span', { text: state.legendOpen ? '▾' : '▸' })
        ])
        ]);
        if (state.legendOpen) {
          const rows = REX.MODULES.map((mod) => el('div', {
            class: 'legend-row',
            style: { opacity: state.visibleModules.has(mod.id) ? 1 : .35 }
          }, [
            el('span', { class: 'module-dot', style: { background: moduleColor(mod) } }),
            el('span', { class: 'module-name', text: mod.label })
          ]));
          if (hasUncalled) {
            rows.push(el('div', { class: 'legend-row' }, [
              el('span', { class: 'module-dot legend-uncalled' }),
              el('span', { class: 'module-name', text: 'Uncalled function' })
            ]));
          }
          legend.append(el('div', { class: 'legend-body' }, rows));
        }
      root.append(legend);
    }

    function renderMinimap() {
      if (!minimap || !layoutData || !canvas) return;
      minimap.textContent = '';
      const W = 200, H = 110, PAD = 6;
      const scale = Math.min((W - PAD * 2) / layoutData.bounds.w, (H - PAD * 2) / layoutData.bounds.h);
      const offX = (W - layoutData.bounds.w * scale) / 2;
      const offY = (H - layoutData.bounds.h * scale) / 2;
      const svg = svgEl('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H });
      const g = svgEl('g', { transform: 'translate(' + offX + ' ' + offY + ') scale(' + scale + ')' });
      REX.FUNCTIONS.forEach((fn) => {
        const pos = layoutData.positions[fn.id];
        if (!pos) return;
        g.append(svgEl('rect', { x: pos.x, y: pos.y, width: NODE_W, height: NODE_H, rx: 6, fill: moduleColor(REX.MOD_BY_ID[fn.module]), opacity: .8 }));
      });
      svg.append(g);
      const viewport = canvas.getBoundingClientRect();
      const vx = -state.transform.x / state.transform.scale;
      const vy = -state.transform.y / state.transform.scale;
      const vw = viewport.width / state.transform.scale;
      const vh = viewport.height / state.transform.scale;
      svg.append(svgEl('rect', {
        x: offX + vx * scale,
        y: offY + vy * scale,
        width: Math.max(4, vw * scale),
        height: Math.max(4, vh * scale),
        fill: 'rgba(255,255,255,.06)',
        stroke: 'rgba(255,255,255,.85)',
        'stroke-width': 1.2
      }));
      minimap.append(svg, el('div', { class: 'section-label', text: 'Map', style: { position: 'absolute', left: '0', top: '4px' } }));
      minimap.onclick = (event) => {
        const rect = minimap.getBoundingClientRect();
        const wx = (event.clientX - rect.left - offX) / scale;
        const wy = (event.clientY - rect.top - offY) / scale;
        state.transform.x = viewport.width / 2 - wx * state.transform.scale;
        state.transform.y = viewport.height / 2 - wy * state.transform.scale;
        applyTransform();
      };
    }

    function renderInspector(root) {
      const inspector = el('aside', { class: 'inspector' });
      const fn = state.selectedId ? REX.FN_BY_ID[state.selectedId] : null;
      if (!fn) {
        inspector.append(el('div', { class: 'inspector-body' }, [
          el('div', { class: 'section-label', text: 'Inspector' }),
          el('p', { text: 'Select a function to inspect its signature, callers, and callees.', style: { color: 'var(--muted)', margin: '14px 0 0' } })
        ]));
        root.append(inspector);
        return;
      }
      const mod = REX.MOD_BY_ID[fn.module];
      const callers = REX.EDGES.filter((edge) => edge.to === fn.id).map((edge) => edge.from);
      inspector.append(el('div', { class: 'inspector-head' }, [
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
          el('span', { class: 'pill', text: mod.label, style: { color: moduleColor(mod), background: moduleColor(mod, .45, 'bg') } }),
          el('span', { class: 'pill', text: fn.kind })
        ]),
        el('h2', { text: fn.name }),
        el('code', { class: 'sig', text: fn.sig })
      ]));
      inspector.append(el('div', { class: 'inspector-body' }, [
        el('p', { text: fn.doc, style: { color: 'var(--muted)', margin: '0 0 16px' } }),
        el('div', { class: 'metrics' }, [
          metric('callers', callers.length),
          metric('calls', fn.calls.length),
          metric('x total', REX.CALL_COUNT[fn.id] || 0)
        ]),
        relList('Called by', callers),
        relList('Calls', fn.calls)
      ]));
      root.append(inspector);
    }

    function metric(label, value) {
      return el('div', { class: 'metric' }, [el('strong', { text: value }), el('span', { text: label })]);
    }

    function relList(title, ids) {
      const items = ids.length
        ? ids.map((id) => {
            const fn = REX.FN_BY_ID[id];
            if (!fn) return null;
            const mod = REX.MOD_BY_ID[fn.module];
            return el('button', {
              class: 'rel-row',
              type: 'button',
              onmouseenter: () => { state.hoverId = id; renderGraphOnly(); },
              onmouseleave: () => { state.hoverId = null; renderGraphOnly(); },
              onclick: () => setSelected(id)
            }, [
              el('span', { class: 'rel-dot', style: { background: moduleColor(mod) } }),
              el('span', { class: 'rel-name', text: fn.name }),
              el('span', { class: 'count', text: mod.label })
            ]);
          }).filter(Boolean)
        : [el('div', { text: 'None', style: { color: 'var(--soft)', fontSize: '11.5px', marginBottom: '12px' } })];
      return el('div', {}, [el('div', { class: 'rel-title', text: title + ' · ' + ids.length }), ...items]);
    }

    function openContextMenu(x, y) {
      const menu = document.getElementById('contextMenu');
      menu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
      menu.style.top = Math.min(y, window.innerHeight - 210) + 'px';
      menu.classList.add('open');
    }

    function closeContextMenu() {
      document.getElementById('contextMenu')?.classList.remove('open');
    }

    function buildExportSvgString() {
      const width = Math.ceil(layoutData.bounds.w);
      const height = Math.ceil(layoutData.bounds.h);
      const parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">'];
      parts.push('<rect width="100%" height="100%" fill="#111216"/>');
      REX.EDGES.forEach((edge) => {
        const from = layoutData.positions[edge.from];
        const to = layoutData.positions[edge.to];
        if (!from || !to) return;
        const mod = REX.MOD_BY_ID[REX.FN_BY_ID[edge.from].module];
        parts.push('<path d="' + edgePath(from, to) + '" fill="none" stroke="' + moduleColor(mod, .72, 'edge') + '" stroke-width="1.4" stroke-linecap="round"/>');
      });
      REX.FUNCTIONS.forEach((fn) => {
        const pos = layoutData.positions[fn.id];
        if (!pos) return;
        const mod = REX.MOD_BY_ID[fn.module];
        parts.push('<rect x="' + pos.x + '" y="' + pos.y + '" width="' + NODE_W + '" height="' + NODE_H + '" rx="8" fill="#2d2e35" stroke="' + moduleColor(mod) + '" stroke-width="1"/>');
        parts.push('<text x="' + (pos.x + 10) + '" y="' + (pos.y + 24) + '" fill="#ebe9e2" font-family="monospace" font-size="12">' + escapeXml(fn.name) + '</text>');
      });
      parts.push('</svg>');
      return parts.join('');
    }

    function escapeXml(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
    }

    function exportPng() {
      const serialized = buildExportSvgString();
      const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }));
      const img = new Image();
      img.onload = () => {
        try {
          const out = document.createElement('canvas');
          out.width = layoutData.bounds.w;
          out.height = layoutData.bounds.h;
          const ctx = out.getContext('2d');
          if (!ctx) throw new Error('Canvas rendering is unavailable.');
          ctx.drawImage(img, 0, 0);
          vscode.postMessage({ type: 'exportPng', png: out.toDataURL('image/png') });
        } catch (error) {
          vscode.postMessage({ type: 'exportPngError', error: error && error.message ? error.message : 'Unable to export PNG.' });
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        vscode.postMessage({ type: 'exportPngError', error: 'Unable to export PNG because the graph image could not be rendered.' });
      };
      img.src = url;
    }

      function renderContextMenu() {
        const menu = el('div', { class: 'context-menu', id: 'contextMenu' }, [
          el('button', { type: 'button', id: 'toggleNodeMovement', text: 'Allow Node Movement', onclick: () => { state.movementEnabled = !state.movementEnabled; if (!state.movementEnabled) finishNodeDrag(); closeContextMenu(); renderContextMenu(); } }),
          el('button', { type: 'button', text: 'Reset View', onclick: () => { closeContextMenu(); resetGraphView(); } }),
          el('button', { type: 'button', text: 'Export JSON', onclick: () => { closeContextMenu(); vscode.postMessage({ type: 'exportGraphJson' }); } }),
          el('button', { type: 'button', text: 'Export DOT', onclick: () => { closeContextMenu(); vscode.postMessage({ type: 'exportDot' }); } }),
          el('button', { type: 'button', text: 'Export Excalidraw', onclick: () => { closeContextMenu(); vscode.postMessage({ type: 'exportExcalidraw' }); } }),
        el('button', { type: 'button', text: 'Export SVG', onclick: () => { closeContextMenu(); vscode.postMessage({ type: 'exportSvg', svg: buildExportSvgString() }); } }),
        el('button', { type: 'button', text: 'Export PNG', onclick: () => { closeContextMenu(); exportPng(); } })
        ]);
        const movementButton = menu.querySelector('#toggleNodeMovement');
        if (movementButton) movementButton.textContent = state.movementEnabled ? 'Disable Node Movement' : 'Allow Node Movement';
        document.getElementById('contextMenu')?.remove();
        document.body.append(menu);
      }

      function render(shouldFit = false) {
        layoutData = applySavedNodePositions(computeLayout());
        app.textContent = '';
        renderToolbar(app);
      const workspace = el('div', { class: 'workspace' });
      renderSidebar(workspace);
      renderGraph(workspace, shouldFit);
      renderInspector(workspace);
      app.append(workspace);
    }

      window.addEventListener('mousemove', (event) => {
        if (nodeDrag && layoutData?.positions?.[nodeDrag.id]) {
          if ((event.buttons & 1) !== 1) {
            finishNodeDrag();
            return;
          }
          const dx = (event.clientX - nodeDrag.x) / state.transform.scale;
          const dy = (event.clientY - nodeDrag.y) / state.transform.scale;
          const next = { x: Math.round(nodeDrag.start.x + dx), y: Math.round(nodeDrag.start.y + dy) };
          state.nodePositions.set(nodeDrag.id, next);
          layoutData.positions[nodeDrag.id] = next;
          layoutData.bounds = computeLayoutBounds(layoutData.positions, layoutData.bounds);
          nodeDrag.moved = nodeDrag.moved || Math.abs(dx) > 2 || Math.abs(dy) > 2;
          renderGraphOnly();
          return;
        }
        if (!drag) return;
        state.transform = { ...drag.t, x: drag.t.x + event.clientX - drag.x, y: drag.t.y + event.clientY - drag.y };
        applyTransform();
      });
      window.addEventListener('mouseup', () => {
        finishNodeDrag();
        drag = null;
        canvas?.classList.remove('panning');
      });
      window.addEventListener('blur', () => {
        finishNodeDrag();
        drag = null;
        canvas?.classList.remove('panning');
      });
    window.addEventListener('resize', () => fitGraph());
    window.addEventListener('click', closeContextMenu);
    window.addEventListener('keydown', (event) => {
      if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(event.target.tagName)) {
        event.preventDefault();
        document.querySelector('.search input')?.focus();
      }
      if (event.key === 'Escape') setSelected(null);
    });
    window.addEventListener('message', (event) => {
      const msg = event && event.data;
      if (!msg) return;
      if (msg.type === 'selectCaller') {
        state.selectedId = REX.FN_BY_ID[msg.caller] ? msg.caller : state.selectedId;
        render();
      }
      if (msg.type === 'triggerExportSvg') {
        vscode.postMessage({ type: 'exportSvg', svg: buildExportSvgString() });
      }
      if (msg.type === 'triggerExportPng') {
        exportPng();
      }
    });

    renderContextMenu();
    render(true);
  </script>
</body>
</html>`;
}

module.exports = { renderGraphHtml };
