const { buildWebviewCsp, createNonce } = require("./shared");

function buildNorthSouthLayers(nodes, edges) {
  const orderedNodes = Array.isArray(nodes)
    ? [...nodes].sort((a, b) => {
        if (a.id === "WORKSPACE") {
          return -1;
        }
        if (b.id === "WORKSPACE") {
          return 1;
        }
        if (a.id === "MAIN") {
          return -1;
        }
        if (b.id === "MAIN") {
          return 1;
        }
        return a.line - b.line || a.id.localeCompare(b.id);
      })
    : [];

  const knownIds = new Set(orderedNodes.map((node) => node.id));
  const outgoing = new Map();
  for (const node of orderedNodes) {
    outgoing.set(node.id, []);
  }

  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!knownIds.has(edge.from) || !knownIds.has(edge.to)) {
      continue;
    }
    outgoing.get(edge.from).push(edge.to);
  }

  const layerById = new Map();
  const rootId = knownIds.has("WORKSPACE") ? "WORKSPACE" : knownIds.has("MAIN") ? "MAIN" : "";
  if (rootId) {
    layerById.set(rootId, 0);
    const queue = [rootId];
    for (let i = 0; i < queue.length; i += 1) {
      const fromId = queue[i];
      const fromLayer = layerById.get(fromId) || 0;
      for (const toId of outgoing.get(fromId) || []) {
        if (!layerById.has(toId)) {
          layerById.set(toId, fromLayer + 1);
          queue.push(toId);
        }
      }
    }
  }

  let maxLayer = 0;
  for (const layer of layerById.values()) {
    maxLayer = Math.max(maxLayer, layer);
  }
  for (const node of orderedNodes) {
    if (!layerById.has(node.id)) {
      maxLayer += 1;
      layerById.set(node.id, maxLayer);
    }
  }

  for (let pass = 0; pass < 2; pass += 1) {
    for (const edge of Array.isArray(edges) ? edges : []) {
      if (edge.from === edge.to || edge.to === "MAIN" || edge.to === "WORKSPACE") {
        continue;
      }
      const fromLayer = layerById.get(edge.from);
      const toLayer = layerById.get(edge.to);
      if (typeof fromLayer !== "number" || typeof toLayer !== "number") {
        continue;
      }
      if (toLayer <= fromLayer) {
        layerById.set(edge.to, fromLayer + 1);
      }
    }
  }

  const byLayer = new Map();
  for (const node of orderedNodes) {
    const layer = layerById.get(node.id) || 0;
    if (!byLayer.has(layer)) {
      byLayer.set(layer, []);
    }
    byLayer.get(layer).push(node);
  }

  return Array.from(byLayer.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, layerNodes]) => layerNodes);
}

function sanitizeCss(cssText) {
  return String(cssText || "")
    .replace(/<\/style/gi, "<\\/style")
    .replace(/@(?:import|charset|namespace)[^;]*;?/gi, "")
    .replace(/@font-face\s*{[\s\S]*?}/gi, "")
    .replace(/url\s*\(\s*[^)]*\)/gi, "url()")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/\b(?:behavior|-moz-binding)\s*:[^;}{]+;?/gi, "");
}

function nodeClassName(node) {
  const classes = [];
  const kind = (node.kind || "").toLowerCase();
  if (kind) {
    classes.push(`kind-${kind.replace(/[^a-z0-9_-]/g, "-")}`);
  }
  if (node.isSignalHandler) {
    classes.push("signal-handler");
  }
  for (const flag of node.flags || []) {
    classes.push(flag.replace(/[^a-z0-9_-]/gi, "-").toLowerCase());
  }
  return classes.join(" ");
}

function edgeClassNames(edge) {
  const classes = [];
  if (edge.type === "terminal" || edge.type === "dynamic") {
    classes.push("edge-terminal", "edge-dynamic");
  }
  if (
    edge.type === "next" ||
    edge.type === "do-body" ||
    edge.type === "loop" ||
    edge.type === "exit-do" ||
    edge.type === "call-dynamic" ||
    edge.type === "signal-value" ||
    edge.type === "when" ||
    edge.type === "when-next" ||
    edge.type === "otherwise"
  ) {
    classes.push("edge-synthetic");
  }

  if (edge.type === "terminal" || edge.type === "dynamic" || edge.type === "signal-value") {
    classes.push("edge-terminal");
  }
  if (edge.type === "dynamic") {
    classes.push("edge-dynamic");
  }
  if (edge.type === "calls-cross-file") {
    classes.push("edge-cross-file");
  }

  return classes.join(" ");
}

function buildEdgeColorMap(nodes, edges) {
  const palette = [
    "#9f4c22",
    "#2a6c58",
    "#2a6684",
    "#805c1e",
    "#5c5d99",
    "#8b3f2c",
    "#55703d",
    "#835063"
  ];

  const targets = new Set(edges.map((e) => e.to));
  const ordered = nodes
    .filter((n) => targets.has(n.id) && n.id !== "MAIN" && n.id !== "WORKSPACE")
    .map((n) => n.id)
    .sort((a, b) => a.localeCompare(b));

  const map = new Map();
  ordered.forEach((target, idx) => {
    map.set(target, palette[idx % palette.length]);
  });
  return map;
}

function edgeCategoryForType(type) {
  if (type === "signal-on") {
    return "signal";
  }
  if (type === "external-call") {
    return "external";
  }
  if (type === "tso-call") {
    return "tso";
  }
  if (type === "calls-dynamic") {
    return "dynamic";
  }
  return "call";
}

function nodeCategoryForKind(kind) {
  if (kind === "external-program") {
    return "external";
  }
  if (kind === "tso-command") {
    return "tso";
  }
  if (kind === "dynamic-call" || kind === "dynamic-jump") {
    return "dynamic";
  }
  return "";
}

function renderDiagnosticsHtml(analysis) {
  const sections = [];
  const withFileMeta = (item, baseMeta) =>
    item.fileLabel ? `${item.fileLabel} • ${baseMeta}` : baseMeta;
  const unreachable = (analysis.unreachableProcedures || []).map((id) => ({
    title: id,
    meta: "Procedure is not reachable from MAIN.",
    nodeId: id,
    line: findMetricLine(analysis, id),
    fileLabel: (analysis.metrics || []).find((metric) => metric.id === id)?.fileLabel || "",
    fileUri: (analysis.metrics || []).find((metric) => metric.id === id)?.fileUri || ""
  }));
  const undefinedLabels = (analysis.undefinedLabels || []).map((item) => ({
    title: item.fileLabel ? `${item.fileLabel} • ${item.id}` : item.id,
    meta: withFileMeta(item, `Undefined target from ${item.callers.join(", ") || "unknown caller"}.`),
    nodeId: item.id,
    line: item.line,
    fileUri: item.fileUri || ""
  }));
  const cycles = (analysis.recursiveCycles || []).map((item) => ({
    title: item.label,
    meta: item.members.join(" -> "),
    nodeId: item.members[0],
    line: item.lines[0],
    fileUri: item.fileUri || ""
  }));
  const cleanup = (analysis.cleanupBypassRisks || []).map((item) => ({
    title: item.fileLabel ? `${item.fileLabel} • ${item.scope}` : item.scope,
    meta: withFileMeta(item, `line ${item.line}: ${item.message}`),
    nodeId: item.scope,
    line: item.line,
    fileUri: item.fileUri || ""
  }));
  const loopRisks = (analysis.possibleInfiniteLoops || []).map((item) => ({
    title: item.fileLabel ? `${item.fileLabel} • ${item.members.join(", ")}` : item.members.join(", "),
    meta: withFileMeta(item, item.message),
    nodeId: item.members[0],
    line: item.lines[0],
    fileUri: item.fileUri || ""
  }));
  const deadCode = (analysis.deadCodeStatements || []).map((item) => ({
    title: item.fileLabel ? `${item.fileLabel} • ${item.scope}` : item.scope,
    meta: withFileMeta(item, `line ${item.line}: unreachable after line ${item.afterLine}.`),
    nodeId: item.scope,
    line: item.line,
    fileUri: item.fileUri || ""
  }));
  const longLines = (analysis.lineLengthWarnings || []).map((item) => ({
    title: item.fileLabel ? `${item.fileLabel} • Line ${item.line}` : `Line ${item.line}`,
    meta: withFileMeta(item, `${item.length} columns (limit ${item.maxColumns}). ${item.preview}`),
    nodeId: "",
    line: item.line,
    fileUri: item.fileUri || ""
  }));

  sections.push(renderDiagnosticSection("Undefined labels", undefinedLabels));
  sections.push(renderDiagnosticSection("Unreachable", unreachable));
  sections.push(renderDiagnosticSection("Recursive cycles", cycles));
  sections.push(renderDiagnosticSection("Loop risks", loopRisks));
  sections.push(renderDiagnosticSection("Dead code", deadCode));
  sections.push(renderDiagnosticSection("Over 80 columns", longLines));
  sections.push(renderDiagnosticSection("Cleanup bypass", cleanup));
  return sections.join("");
}

function renderDiagnosticSection(label, items) {
  const body = items.length
    ? items
        .map(
          (item) => `<div class="diag-item"><button type="button" data-node-id="${escapeHtml(
            item.nodeId || ""
          )}" data-jump-line="${item.line || 1}" data-file-uri="${escapeHtml(
            item.fileUri || ""
          )}"><div class="title-row"><span>${escapeHtml(
            item.title
          )}</span><span>line ${item.line || 1}</span></div><div class="meta-row">${escapeHtml(
            item.meta
          )}</div></button></div>`
        )
        .join("")
    : `<div class="empty">None</div>`;
  return `<div><h3>${escapeHtml(label)}</h3>${body}</div>`;
}

function renderMetricHtml(metrics) {
  if (!metrics.length) {
    return `<div class="empty">No metrics available.</div>`;
  }
  return metrics
    .slice(0, 12)
    .map(
      (metric) => `<div class="metric-item"><div class="title-row"><span>${escapeHtml(
        metric.id
      )}</span><span>CC ${metric.cyclomaticComplexity}</span></div><div class="meta-row">line ${metric.line} • statements ${metric.statementCount} • fan-in ${metric.fanIn} • fan-out ${metric.fanOut} • returns ${metric.returnCount} • exits ${metric.exitCount}</div></div>`
    )
    .join("");
}

function statCard(label, value) {
  return `<div class="stat-card"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(
    value
  )}</span></div>`;
}

function findMetricLine(analysis, id) {
  return (analysis.metrics || []).find((metric) => metric.id === id)?.line || 1;
}

function serializeForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = {
  buildNorthSouthLayers,
  sanitizeCss,
  nodeClassName,
  edgeClassNames,
  buildEdgeColorMap,
  edgeCategoryForType,
  nodeCategoryForKind,
  renderDiagnosticsHtml,
  renderMetricHtml,
  statCard,
  serializeForScript,
  escapeHtml
};
