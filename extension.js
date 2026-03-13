const vscode = require("vscode");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseRexxControlFlow, toDot, toExcalidraw } = require("./parser");

const SUPPORTED_LANGS = new Set(["rexx", "REXX"]);

function activate(context) {
  let graphPanel = null;
  let graphDocumentUri = null;
  let graphData = null;
  let cssWarningKey = null;
  let renderTimer = null;
  let renderNonce = 0;

  const loadCustomCssForDocument = async (doc) => {
    const configuredPath = String(
      vscode.workspace.getConfiguration("rexxFlow").get("customCssFile", "")
    ).trim();
    if (!configuredPath) {
      cssWarningKey = null;
      return "";
    }

    const expandedPath = configuredPath.startsWith("~")
      ? path.join(os.homedir(), configuredPath.slice(1))
      : configuredPath;

    let resolvedPath = expandedPath;
    if (!path.isAbsolute(resolvedPath)) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
      const basePath = workspaceFolder?.uri.fsPath || path.dirname(doc.fileName);
      resolvedPath = path.resolve(basePath, resolvedPath);
    }

    try {
      const css = await fs.readFile(resolvedPath, "utf8");
      cssWarningKey = null;
      return css;
    } catch (err) {
      const key = `${configuredPath}:${err?.code || "ERR"}`;
      if (cssWarningKey !== key) {
        cssWarningKey = key;
        vscode.window.showWarningMessage(
          `REXX Control Flow: Unable to load custom CSS file "${configuredPath}".`
        );
      }
      return "";
    }
  };

  const renderForDocument = async (doc) => {
    const currentNonce = ++renderNonce;
    const graph = parseRexxControlFlow(doc.getText());
    const customCss = await loadCustomCssForDocument(doc);
    const defaultViewMode = String(
      vscode.workspace.getConfiguration("rexxFlow").get("defaultView", "graph")
    ).trim() === "detailed"
      ? "detailed"
      : "graph";
    if (currentNonce !== renderNonce) {
      return;
    }
    graphData = graph;
    if (!graphPanel) {
      graphPanel = vscode.window.createWebviewPanel(
        "rexxControlFlow",
        `REXX Control Flow: ${path.basename(doc.fileName)}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );

      graphPanel.onDidDispose(() => {
        if (renderTimer) {
          clearTimeout(renderTimer);
          renderTimer = null;
        }
        graphPanel = null;
        graphDocumentUri = null;
        graphData = null;
      });

      graphPanel.webview.onDidReceiveMessage(async (msg) => {
        if (!msg || !graphDocumentUri) {
          return;
        }

        if (msg.type === "revealLine") {
          const line = Math.max(1, Number(msg.line) || 1);
          const targetUri = graphDocumentUri;
          const docTarget = await vscode.workspace.openTextDocument(targetUri);
          const editor = await vscode.window.showTextDocument(docTarget, vscode.ViewColumn.One);
          const position = new vscode.Position(line - 1, 0);
          const range = new vscode.Range(position, position);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          return;
        }

        const docTarget = await vscode.workspace.openTextDocument(graphDocumentUri);
        if (!isSupported(docTarget)) {
          return;
        }

        if (msg.type === "exportGraphJson") {
          await exportJsonFromDocument(docTarget);
          return;
        }

        if (msg.type === "exportDot") {
          await exportDotFromDocument(docTarget);
          return;
        }

        if (msg.type === "exportExcalidraw") {
          await exportExcalidrawFromDocument(docTarget);
          return;
        }

        if (msg.type === "exportSvg" && typeof msg.svg === "string") {
          await exportSvgFromDocument(docTarget, msg.svg);
          return;
        }

        if (msg.type === "exportPng" && typeof msg.png === "string") {
          await exportPngFromDocument(docTarget, msg.png);
        }
      });
    }
    if (graphPanel.visible === false) {
      graphPanel.reveal(vscode.ViewColumn.Beside, false);
    }

    graphDocumentUri = doc.uri;
    graphPanel.title = `REXX Control Flow: ${path.basename(doc.fileName)}`;
    graphPanel.webview.html = renderGraphHtml(graph, doc.fileName, customCss, defaultViewMode);

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.toString() === doc.uri.toString()) {
      syncSelectionToGraph(activeEditor);
    }
  };

  const scheduleRender = (doc, delayMs = 120) => {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    renderTimer = setTimeout(() => {
      renderTimer = null;
      void renderForDocument(doc);
    }, delayMs);
  };

  const getFunctionAtLine = (graph, lineNo) => {
    if (!graph || !Array.isArray(graph.nodes)) {
      return "MAIN";
    }

    const functionNodes = graph.nodes
      .filter((n) => n.id !== "DYNAMIC_CALL" && (n.kind === "function" || n.kind === "entry"))
      .sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));

    let selected = "MAIN";
    for (const node of functionNodes) {
      if (node.line <= lineNo) {
        selected = node.id;
      } else {
        break;
      }
    }

    return selected;
  };

  const syncSelectionToGraph = (editor) => {
    if (!graphPanel || !graphDocumentUri || !graphData) {
      return;
    }
    if (!editor || editor.document.uri.toString() !== graphDocumentUri.toString()) {
      return;
    }

    const lineNo = (editor.selection?.active?.line || 0) + 1;
    const caller = getFunctionAtLine(graphData, lineNo);
    graphPanel.webview.postMessage({ type: "selectCaller", caller, reveal: true });
  };

  const getDefaultExportUri = (doc, extension) => {
    const safeExt = String(extension || "").replace(/^\./, "");
    const sourceName = path.basename(doc.fileName || "rexx-control-flow");
    const baseName = path.basename(sourceName, path.extname(sourceName));
    const defaultDir = path.dirname(doc.fileName || "");
    const defaultName = `${baseName}.${safeExt}`;
    if (defaultDir && defaultDir !== ".") {
      return vscode.Uri.file(path.join(defaultDir, defaultName));
    }
    return vscode.Uri.file(path.join(os.homedir(), defaultName));
  };

  const writeExportFile = async (doc, extension, data, filters) => {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: getDefaultExportUri(doc, extension),
      filters: filters || undefined
    });
    if (!uri) {
      return null;
    }
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    await fs.writeFile(uri.fsPath, payload);
    return uri;
  };

  const exportJsonFromDocument = async (doc) => {
    const graph = parseRexxControlFlow(doc.getText());
    const uri = await writeExportFile(
      doc,
      "json",
      JSON.stringify(graph, null, 2),
      { JSON: ["json"] }
    );
    if (!uri) {
      return;
    }
    const target = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(target, vscode.ViewColumn.Beside);
  };

  const exportDotFromDocument = async (doc) => {
    const graph = parseRexxControlFlow(doc.getText());
    const uri = await writeExportFile(doc, "dot", toDot(graph), { "Graphviz DOT": ["dot"] });
    if (!uri) {
      return;
    }
    const target = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(target, vscode.ViewColumn.Beside);
  };

  const exportExcalidrawFromDocument = async (doc) => {
    const graph = parseRexxControlFlow(doc.getText());
    const uri = await writeExportFile(
      doc,
      "excalidraw",
      toExcalidraw(graph),
      { Excalidraw: ["excalidraw"] }
    );
    if (!uri) {
      return;
    }
    const target = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(target, vscode.ViewColumn.Beside);
  };

  const exportSvgFromDocument = async (doc, svgText) => {
    await writeExportFile(doc, "svg", svgText, { SVG: ["svg"] });
  };

  const exportPngFromDocument = async (doc, pngDataUrl) => {
    const clean = String(pngDataUrl || "").replace(/^data:image\/png;base64,/, "");
    if (!clean) {
      return;
    }
    await writeExportFile(doc, "png", Buffer.from(clean, "base64"), { PNG: ["png"] });
  };

  const show = vscode.commands.registerCommand("rexxFlow.showControlGraph", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupported(editor.document)) {
      vscode.window.showWarningMessage("Open a REXX file to generate control flow.");
      return;
    }

    await renderForDocument(editor.document);
  });

  const exportJson = vscode.commands.registerCommand("rexxFlow.exportGraphJson", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupported(editor.document)) {
      vscode.window.showWarningMessage("Open a REXX file to export control flow.");
      return;
    }

    await exportJsonFromDocument(editor.document);
  });

  const exportDot = vscode.commands.registerCommand("rexxFlow.exportDot", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupported(editor.document)) {
      vscode.window.showWarningMessage("Open a REXX file to export control flow.");
      return;
    }

    await exportDotFromDocument(editor.document);
  });

  const exportExcalidraw = vscode.commands.registerCommand("rexxFlow.exportExcalidraw", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupported(editor.document)) {
      vscode.window.showWarningMessage("Open a REXX file to export control flow.");
      return;
    }

    await exportExcalidrawFromDocument(editor.document);
  });

  const onDocumentChange = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!graphPanel || !graphDocumentUri) {
      return;
    }
    if (event.document.uri.toString() !== graphDocumentUri.toString()) {
      return;
    }
    scheduleRender(event.document);
  });

  const onDocumentSave = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (!graphPanel || !graphDocumentUri) {
      return;
    }
    if (doc.uri.toString() !== graphDocumentUri.toString()) {
      return;
    }
    scheduleRender(doc, 0);
  });

  const onSelectionChange = vscode.window.onDidChangeTextEditorSelection((event) => {
    syncSelectionToGraph(event.textEditor);
  });

  const onConfigChange = vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (
      !event.affectsConfiguration("rexxFlow.customCssFile") &&
      !event.affectsConfiguration("rexxFlow.defaultView")
    ) {
      return;
    }
    if (!graphPanel || !graphDocumentUri) {
      return;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(graphDocumentUri);
      await renderForDocument(doc);
    } catch {
      // Ignore if the document can no longer be opened.
    }
  });

  context.subscriptions.push(
    show,
    exportJson,
    exportDot,
    exportExcalidraw,
    onDocumentChange,
    onDocumentSave,
    onSelectionChange,
    onConfigChange
  );
}

function isSupported(doc) {
  if (SUPPORTED_LANGS.has(doc.languageId)) {
    return true;
  }
  const name = doc.fileName.toLowerCase();
  return name.endsWith(".rexx") || name.endsWith(".rex") || name.endsWith(".exec");
}

function buildNorthSouthLayers(nodes, edges) {
  const orderedNodes = Array.isArray(nodes)
    ? [...nodes].sort((a, b) => {
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
  if (knownIds.has("MAIN")) {
    layerById.set("MAIN", 0);
    const queue = ["MAIN"];
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
      if (edge.from === edge.to || edge.to === "MAIN") {
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
  return String(cssText || "").replace(/<\/style/gi, "<\\/style");
}

function renderGraphHtml(graph, fileName, customCss = "", defaultViewMode = "graph") {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const analysis = graph.analysis || {};
  const edgeColorByTarget = buildEdgeColorMap(nodes, edges);
  const metricById = new Map((analysis.metrics || []).map((metric) => [metric.id, metric]));

  const cardWidth = 192;
  const cardHeight = 72;
  const gapX = 72;
  const gapY = 76;
  const margin = 42;
  const layers = buildNorthSouthLayers(nodes, edges);
  const cols = Math.max(1, ...layers.map((layer) => layer.length));

  const positions = new Map();
  layers.forEach((layer, row) => {
    const rowWidth = layer.length * cardWidth + Math.max(0, layer.length - 1) * gapX;
    const xStart = margin + Math.max(0, Math.round((cols * (cardWidth + gapX) - gapX - rowWidth) / 2));
    layer.forEach((node, col) => {
      const x = xStart + col * (cardWidth + gapX);
      const y = margin + row * (cardHeight + gapY);
      positions.set(node.id, { x, y });
    });
  });

  const totalRows = layers.length;
  const width = Math.max(720, margin * 2 + cols * cardWidth + Math.max(0, cols - 1) * gapX);
  const height = Math.max(420, margin * 2 + totalRows * cardHeight + Math.max(0, totalRows - 1) * gapY);

  const edgeSvg = edges
    .map((edge) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) {
        return "";
      }

      const x1 = from.x + cardWidth / 2;
      const y1 = from.y + cardHeight / 2;
      const x2 = to.x + cardWidth / 2;
      const y2 = to.y + cardHeight / 2;
      const mx = Math.round((x1 + x2) / 2);
      const my = Math.round((y1 + y2) / 2) - 6;
      const classNames = edgeClassNames(edge);
      const edgeCategory = edgeCategoryForType(edge.type);

      const edgeColor = edgeColorByTarget.get(edge.to) || "#2f4858";

      return [
        `<g class="edge-group ${classNames}" data-edge-type="${escapeHtml(edge.type)}" data-from="${escapeHtml(
          edge.from
        )}" data-to="${escapeHtml(edge.to)}" data-line="${edge.line}" data-category="${edgeCategory}">`,
        `<line class="edge" style="stroke:${edgeColor}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#arrow)" />`,
        `<text class="edge-label" style="fill:${edgeColor}" x="${mx}" y="${my}">${escapeHtml(edge.type)}</text>`,
        `</g>`
      ].join("");
    })
    .join("\n");

  const nodeHtml = nodes
    .map((node) => {
      const pos = positions.get(node.id);
      const metric = metricById.get(node.id);
      const flagChips = (node.flags || [])
        .map((flag) => `<span class="flag-chip flag-${escapeHtml(flag)}">${escapeHtml(flag)}</span>`)
        .join("");
      return `<button class="node ${nodeClassName(node)}" data-line="${node.line}" data-kind="${escapeHtml(
        node.kind || ""
      )}" data-node-id="${escapeHtml(node.id)}" data-section-id="${escapeHtml(
        node.sectionId || ""
      )}" data-cycle-id="${escapeHtml(node.cycleId || "")}" style="left:${pos.x}px;top:${pos.y}px" title="Click to focus, double-click to jump to line ${node.line}">
        <div class="node-head">
          <div class="name">${escapeHtml(node.label)}</div>
          <div class="badges">${flagChips}</div>
        </div>
        <div class="meta">line ${node.line}${metric ? ` • CC ${metric.cyclomaticComplexity} • fan ${metric.fanIn}/${metric.fanOut}` : ""}</div>
      </button>`;
    })
    .join("\n");

  const graphTitle = `${escapeHtml(fileName)} | Nodes: ${nodes.length} | Edges: ${edges.length}`;
  const statsHtml = [
    statCard("Undefined labels", (analysis.undefinedLabels || []).length),
    statCard("Unreachable", (analysis.unreachableProcedures || []).length),
    statCard("Recursive cycles", (analysis.recursiveCycles || []).length),
    statCard("Cleanup risks", (analysis.cleanupBypassRisks || []).length),
    statCard("Dead code", (analysis.deadCodeStatements || []).length),
    statCard("> 80 cols", (analysis.lineLengthWarnings || []).length)
  ].join("");
  const diagnosticsHtml = renderDiagnosticsHtml(analysis);
  const groupModeOptions = [
    ["section", "Logical section"],
    ["cycle", "Recursion cycle"],
    ["kind", "Node kind"],
    ["file", "File"]
  ]
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  const customCssBlock = customCss ? `\n  <style id="user-css">\n${sanitizeCss(customCss)}\n  </style>` : "";
  const graphDataJson = serializeForScript(graph);
  const advancedOpenAttr = defaultViewMode === "detailed" ? " open" : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>REXX Call Graph</title>
  <style>
    :root {
      --bg: #efe7d6;
      --panel: rgba(255, 252, 245, 0.92);
      --card: #fffdf8;
      --line: #33404c;
      --ink: #202833;
      --muted: #6a7681;
      --accent: #a34a1c;
      --accent-2: #d9863f;
      --border: #ccbfa9;
      --edge-soft: #d9cdb9;
      --danger: #b53827;
      --warning: #c97a17;
      --success: #2a6c58;
      --info: #2a6684;
      --external-program-bg: #e2f2fb;
      --external-program-border: #31759c;
      --external-program-text: #154e71;
      --tso-command-bg: #efe8ff;
      --tso-command-border: #6a55a1;
      --tso-command-text: #453273;
    }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.65), transparent 30%),
        linear-gradient(135deg, #e8dcc5 0%, #efe7d6 42%, #ddd0b7 100%);
      color: var(--ink);
      font-family: "Avenir Next", "Segoe UI", sans-serif;
    }
    .wrap {
      padding: 18px;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .toggle-button {
      border: 1px solid #9f8f76;
      border-radius: 10px;
      background: #fffdf8;
      color: #27323c;
      padding: 7px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    .layout {
      display: grid;
      grid-template-columns: 310px minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    body.graph-mode .layout {
      grid-template-columns: 1fr;
    }
    body.graph-mode .sidebar,
    body.graph-mode .stats {
      display: none;
    }
    .sidebar,
    .main-panel {
      background: var(--panel);
      border: 1px solid rgba(117, 98, 74, 0.24);
      border-radius: 20px;
      box-shadow: 0 20px 40px rgba(62, 42, 25, 0.08);
      backdrop-filter: blur(10px);
    }
    .sidebar {
      padding: 14px;
      display: grid;
      gap: 12px;
      position: sticky;
      top: 18px;
      max-height: calc(100vh - 36px);
      overflow: auto;
    }
    .main-panel {
      padding: 16px;
    }
    .title {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.02em;
      margin-bottom: 6px;
    }
    .subtitle {
      color: var(--muted);
      margin-bottom: 14px;
      font-size: 13px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .stat-card {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.72);
      padding: 10px 12px;
    }
    .stat-card .label {
      display: block;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .stat-card .value {
      display: block;
      margin-top: 6px;
      font-size: 22px;
      font-weight: 800;
      color: var(--accent);
    }
    .controls {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto;
      gap: 10px;
      margin-bottom: 12px;
    }
    .control-block {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.78);
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    .control-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .controls button,
    .controls input,
    .controls select,
    .sidebar button {
      border: 1px solid #9f8f76;
      border-radius: 10px;
      background: #fffdf8;
      color: #27323c;
      padding: 7px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    .controls input {
      cursor: text;
      width: 100%;
      box-sizing: border-box;
    }
    .controls button:disabled,
    .sidebar button:disabled {
      opacity: 0.45;
      cursor: default;
    }
    details.advanced {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: rgba(255,255,255,0.7);
      overflow: hidden;
    }
    details.advanced > summary {
      list-style: none;
      cursor: pointer;
      padding: 12px 14px;
      font-size: 13px;
      font-weight: 700;
      color: var(--ink);
      background: rgba(255,255,255,0.5);
      border-bottom: 1px solid transparent;
    }
    details.advanced[open] > summary {
      border-bottom-color: var(--border);
    }
    details.advanced > summary::-webkit-details-marker {
      display: none;
    }
    .advanced-body {
      padding: 14px;
    }
    .zoom-pill {
      font-size: 12px;
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 7px 10px;
      background: #fffdf8;
      align-self: start;
    }
    .filter-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 9px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.86);
      font-size: 12px;
    }
    .filter-chip input {
      width: auto;
    }
    .canvas {
      position: relative;
      width: 100%;
      height: min(78vh, calc(100vh - 250px));
      min-height: 420px;
      border: 1px solid var(--border);
      border-radius: 18px;
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.7), transparent 25%),
        linear-gradient(180deg, rgba(255,255,255,0.76), rgba(246,241,232,0.92));
      overflow: auto;
      cursor: grab;
    }
    .canvas.panning {
      cursor: grabbing;
      user-select: none;
    }
    .graph-content {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      transform-origin: 0 0;
    }
    .graph-content svg {
      position: absolute;
      inset: 0;
    }
    .edge-group.hidden,
    .node.hidden,
    .group-item.hidden {
      display: none !important;
    }
    .edge {
      stroke: var(--line);
      stroke-width: 2;
      opacity: 0.72;
    }
    .edge-label {
      font-size: 10px;
      fill: var(--muted);
      text-anchor: middle;
      paint-order: stroke;
      stroke: rgba(255,255,255,0.9);
      stroke-width: 2px;
      stroke-linejoin: round;
    }
    .edge-group.dimmed .edge,
    .edge-group.dimmed .edge-label {
      opacity: 0.3;
    }
    .edge-group.active .edge {
      opacity: 1;
      stroke-width: 3.6;
    }
    .edge-group.active .edge-label {
      opacity: 1;
      font-weight: 700;
    }
    .node {
      position: absolute;
      width: ${cardWidth}px;
      height: ${cardHeight}px;
      border: 1px solid #af9f86;
      border-radius: 16px;
      background: rgba(255, 253, 248, 0.95);
      box-shadow: 0 8px 20px rgba(82, 61, 37, 0.12);
      padding: 8px 10px;
      box-sizing: border-box;
      text-align: left;
      cursor: pointer;
      transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
    }
    .node:hover {
      border-color: #7f684a;
      transform: translateY(-1px);
    }
    .node.selected {
      border-color: #4c5f70;
      box-shadow: 0 0 0 3px rgba(76, 95, 112, 0.18), 0 10px 22px rgba(82, 61, 37, 0.15);
    }
    .node.search-hit {
      box-shadow: 0 0 0 3px rgba(217, 134, 63, 0.18), 0 10px 22px rgba(82, 61, 37, 0.15);
    }
    .node.signal-handler {
      border-color: var(--danger);
      background: #fff1ee;
    }
    .node.signal-handler .name {
      color: var(--danger);
    }
    .node.unreachable {
      background: #f5eadf;
      border-style: dashed;
    }
    .node.orphan {
      border-color: var(--warning);
    }
    .node.recursive {
      box-shadow: 0 0 0 2px rgba(217, 134, 63, 0.2), 0 8px 20px rgba(82, 61, 37, 0.12);
    }
    .node.undefined {
      border-color: var(--danger);
    }
    .node.dead-code {
      background: #f2ede6;
    }
    .node .name {
      font-weight: 700;
      font-size: 14px;
      color: var(--accent);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      pointer-events: none;
    }
    .node-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 6px;
    }
    .badges {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      justify-content: flex-end;
      max-width: 72px;
    }
    .flag-chip {
      border-radius: 999px;
      padding: 2px 6px;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: #f0e7d8;
      color: #6a5b46;
    }
    .flag-chip.flag-unreachable,
    .flag-chip.flag-orphan {
      background: #f6e4c2;
      color: #7b4f08;
    }
    .flag-chip.flag-recursive {
      background: #f7d9c3;
      color: #8a431d;
    }
    .flag-chip.flag-dead-code {
      background: #ece6dd;
      color: #5f5548;
    }
    .flag-chip.flag-undefined {
      background: #f8d8d2;
      color: #962d20;
    }
    .node .meta {
      margin-top: 8px;
      color: var(--muted);
      font-size: 11px;
      pointer-events: none;
    }
    .node.kind-synthetic,
    .node.kind-statement,
    .node.kind-dynamic-call,
    .node.kind-dynamic-jump {
      background: #f4f8fb;
    }
    .node.kind-external-program {
      border-color: var(--external-program-border);
      background: var(--external-program-bg);
    }
    .node.kind-external-program .name {
      color: var(--external-program-text);
    }
    .node.kind-tso-command {
      border-color: var(--tso-command-border);
      background: var(--tso-command-bg);
    }
    .node.kind-tso-command .name {
      color: var(--tso-command-text);
    }
    .panel {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: rgba(255,255,255,0.72);
      padding: 10px;
    }
    .panel h3 {
      margin: 0 0 8px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .diag-list,
    .metric-list,
    .group-list {
      display: grid;
      gap: 8px;
    }
    .diag-item,
    .group-item,
    .metric-item {
      border: 1px solid rgba(159, 143, 118, 0.45);
      border-radius: 12px;
      background: #fffdf8;
      padding: 8px 9px;
    }
    .diag-item button,
    .group-item button {
      width: 100%;
      text-align: left;
      background: transparent;
      border: 0;
      padding: 0;
      color: inherit;
    }
    .diag-item .title-row,
    .group-item .title-row,
    .metric-item .title-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      font-size: 12px;
      font-weight: 700;
    }
    .diag-item .meta-row,
    .group-item .meta-row,
    .metric-item .meta-row {
      margin-top: 6px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.4;
    }
    .empty {
      color: var(--muted);
      font-size: 12px;
    }
    .group-toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    @media (max-width: 1080px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .sidebar {
        position: static;
        max-height: none;
      }
      .controls {
        grid-template-columns: 1fr;
      }
      .stats {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  </style>${customCssBlock}
</head>
<body>
  <div class="wrap" id="app">
    <div class="topbar">
      <div>
        <div class="title">REXX Control Flow</div>
        <div class="subtitle">${graphTitle}</div>
      </div>
      <div class="topbar-actions">
        <button id="toggleViewMode" class="toggle-button" type="button">${
          defaultViewMode === "detailed" ? "Graph Only" : "Detailed View"
        }</button>
      </div>
    </div>
    <div class="layout">
      <aside class="sidebar">
        <div>
          <details class="advanced"${advancedOpenAttr}>
            <summary>Diagnostics</summary>
            <div class="advanced-body panel">
              <div class="diag-list" id="diagnosticsPanel">${diagnosticsHtml}</div>
            </div>
          </details>
        </div>
        <details class="advanced"${advancedOpenAttr}>
          <summary>Groups</summary>
          <div class="advanced-body panel">
            <div class="group-toolbar">
              <button id="collapseAllGroups" type="button">Collapse all</button>
              <button id="expandAllGroups" type="button">Expand all</button>
            </div>
            <div class="group-list" id="groupList"></div>
          </div>
        </details>
        <details class="advanced"${advancedOpenAttr}>
          <summary>Complexity</summary>
          <div class="advanced-body panel">
            <div class="metric-list" id="metricList">${renderMetricHtml(analysis.metrics || [])}</div>
          </div>
        </details>
      </aside>

      <main class="main-panel">
        <div class="stats">${statsHtml}</div>
        <details class="advanced"${advancedOpenAttr}>
          <summary>Graph Controls</summary>
          <div class="advanced-body controls">
          <div class="control-block">
            <div class="control-row">
              <input id="nodeSearch" type="search" placeholder="Search procedures, labels, or targets" />
              <button id="searchNext" type="button">Next</button>
              <button id="clearSearch" type="button">Clear</button>
            </div>
            <div class="control-row">
              <label class="filter-chip"><input id="filterCalls" type="checkbox" checked /> calls</label>
              <label class="filter-chip"><input id="filterSignals" type="checkbox" checked /> signals</label>
              <label class="filter-chip"><input id="filterExternal" type="checkbox" checked /> external</label>
              <label class="filter-chip"><input id="filterTso" type="checkbox" checked /> tso</label>
              <label class="filter-chip"><input id="filterDynamic" type="checkbox" checked /> dynamic</label>
            </div>
          </div>
          <div class="control-block">
            <div class="control-row">
              <button id="navBack" type="button">Back</button>
              <button id="navForward" type="button">Forward</button>
              <button id="focusMode" type="button">Focus: Off</button>
              <select id="groupMode">${groupModeOptions}</select>
              <button id="showAllNodes" type="button">Show all nodes</button>
            </div>
            <div class="control-row">
              <button id="exportJson" type="button">Export JSON</button>
              <button id="exportDot" type="button">Export DOT</button>
              <button id="exportExcalidraw" type="button">Export Excalidraw</button>
              <button id="downloadSvg" type="button">Export SVG</button>
              <button id="downloadPng" type="button">Export PNG</button>
            </div>
          </div>
          <div class="control-block">
            <div class="control-row">
              <button id="zoomOut" type="button">-</button>
              <button id="zoomIn" type="button">+</button>
              <select id="zoomPreset" title="Zoom level">
                <option value="50">50%</option>
                <option value="75">75%</option>
                <option value="100" selected>100%</option>
                <option value="125">125%</option>
                <option value="150">150%</option>
                <option value="200">200%</option>
              </select>
              <button id="resetZoom" type="button">Reset</button>
            </div>
            <div class="zoom-pill">Zoom: <span id="zoomLevel">100%</span></div>
          </div>
          </div>
        </details>

        <div class="canvas" id="canvasWrap">
          <div class="graph-content" id="graphContent">
            <svg id="graphSvg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="strokeWidth">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"></path>
                </marker>
              </defs>
              ${edgeSvg}
            </svg>
            ${nodeHtml}
          </div>
        </div>
      </main>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const graphData = ${graphDataJson};

    const nodes = Array.from(document.querySelectorAll('.node'));
    const edgeGroups = Array.from(document.querySelectorAll('.edge-group'));
    const canvasWrap = document.getElementById('canvasWrap');
    const graphContent = document.getElementById('graphContent');
    const zoomLevel = document.getElementById('zoomLevel');
    const zoomPreset = document.getElementById('zoomPreset');
    const nodeSearch = document.getElementById('nodeSearch');
    const groupList = document.getElementById('groupList');
    const groupMode = document.getElementById('groupMode');
    const toggleViewMode = document.getElementById('toggleViewMode');
    const navBack = document.getElementById('navBack');
    const navForward = document.getElementById('navForward');
    const focusModeButton = document.getElementById('focusMode');
    const persisted = vscode.getState() || {};
    let selectedCaller = null;
    let zoomScale = 1;
    let searchMatches = [];
    let searchIndex = -1;
    let collapsedGroupIds = new Set();
    let navigationHistory = [];
    let navigationIndex = -1;
    let focusModeEnabled = false;
    let viewMode = '${defaultViewMode}';
    const minZoom = 0.4;
    const maxZoom = 2.5;
    const zoomFactor = 1.12;
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    let panStartScrollLeft = 0;
    let panStartScrollTop = 0;

    function esc(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function persistState() {
      vscode.setState({
        selectedCaller,
        zoomScale,
        nodeSearch: nodeSearch.value || '',
        groupMode: groupMode.value,
        collapsedGroupIds: Array.from(collapsedGroupIds),
        filters: currentEdgeFilters(),
        navigationHistory,
        navigationIndex,
        focusModeEnabled,
        viewMode
      });
    }

    function applyViewMode() {
      document.body.classList.toggle('graph-mode', viewMode === 'graph');
      toggleViewMode.textContent = viewMode === 'graph' ? 'Detailed View' : 'Graph Only';
    }

    function currentEdgeFilters() {
      return {
        call: document.getElementById('filterCalls').checked,
        signal: document.getElementById('filterSignals').checked,
        external: document.getElementById('filterExternal').checked,
        tso: document.getElementById('filterTso').checked,
        dynamic: document.getElementById('filterDynamic').checked
      };
    }

    function groupIdForNode(node) {
      const mode = groupMode.value;
      if (mode === 'section') {
        return node.getAttribute('data-section-id') || 'section:ungrouped';
      }
      if (mode === 'cycle') {
        return node.getAttribute('data-cycle-id') || 'cycle:none';
      }
      if (mode === 'kind') {
        return 'kind:' + (node.getAttribute('data-kind') || 'unknown');
      }
      return 'file:current';
    }

    function visibleNodeIds() {
      const ids = new Set();
      nodes.forEach((node) => {
        if (!node.classList.contains('hidden')) {
          ids.add(node.getAttribute('data-node-id'));
        }
      });
      return ids;
    }

    function applyState() {
      const searchTerm = (nodeSearch.value || '').trim().toUpperCase();
      const filters = currentEdgeFilters();
      const focusNodeIds = new Set();
      if (focusModeEnabled && selectedCaller) {
        focusNodeIds.add(selectedCaller);
        edgeGroups.forEach((edge) => {
          const from = edge.getAttribute('data-from');
          const to = edge.getAttribute('data-to');
          if (from === selectedCaller || to === selectedCaller) {
            focusNodeIds.add(from);
            focusNodeIds.add(to);
          }
        });
      }

      nodes.forEach((node) => {
        const text = node.getAttribute('data-node-id') || '';
        const matchesSearch = !searchTerm || text.includes(searchTerm);
        const hiddenByGroup = collapsedGroupIds.has(groupIdForNode(node));
        const hiddenByFocus =
          focusModeEnabled && selectedCaller && !focusNodeIds.has(node.getAttribute('data-node-id'));
        const hidden = hiddenByGroup || hiddenByFocus;
        node.classList.toggle('hidden', hidden);
        node.classList.toggle('search-hit', matchesSearch && !hidden && Boolean(searchTerm));
        node.classList.toggle('selected', node.getAttribute('data-node-id') === selectedCaller);
      });

      const visibleIds = visibleNodeIds();
      const hasOutgoing = selectedCaller
        ? edgeGroups.some((edge) => {
            const from = edge.getAttribute('data-from');
            const to = edge.getAttribute('data-to');
            const category = edge.getAttribute('data-category');
            return from === selectedCaller && Boolean(filters[category]) && visibleIds.has(from) && visibleIds.has(to);
          })
        : false;

      edgeGroups.forEach((edge) => {
        const from = edge.getAttribute('data-from');
        const to = edge.getAttribute('data-to');
        const category = edge.getAttribute('data-category');
        const categoryAllowed = Boolean(filters[category]);
        const endpointsVisible = visibleIds.has(from) && visibleIds.has(to);
        const hidden = !categoryAllowed || !endpointsVisible;
        const isActive = !selectedCaller || (hasOutgoing ? from === selectedCaller : to === selectedCaller);
        edge.classList.toggle('hidden', hidden);
        edge.classList.toggle('active', !hidden && Boolean(selectedCaller && isActive));
        edge.classList.toggle('dimmed', !hidden && Boolean(selectedCaller && !isActive));
      });

      refreshGroupList();
      updateSearchMatches();
      updateNavigationUi();
      persistState();
    }

    function updateSearchMatches() {
      const searchTerm = (nodeSearch.value || '').trim().toUpperCase();
      searchMatches = nodes.filter((node) => {
        if (node.classList.contains('hidden')) {
          return false;
        }
        const text = node.getAttribute('data-node-id') || '';
        return searchTerm && text.includes(searchTerm);
      });
      if (!searchMatches.length) {
        searchIndex = -1;
      } else if (searchIndex >= searchMatches.length) {
        searchIndex = 0;
      }
    }

    function focusNodeById(nodeId) {
      if (!nodeId) {
        return;
      }
      const node = nodes.find((n) => n.getAttribute('data-node-id') === nodeId);
      if (!node) {
        return;
      }

      const targetX = (node.offsetLeft + node.offsetWidth / 2) * zoomScale - canvasWrap.clientWidth / 2;
      const targetY = (node.offsetTop + node.offsetHeight / 2) * zoomScale - canvasWrap.clientHeight / 2;
      canvasWrap.scrollTo({
        left: Math.max(0, targetX),
        top: Math.max(0, targetY),
        behavior: 'smooth'
      });
    }

    function focusNode(node, options = {}) {
      const { pushHistory = true, revealLine = true } = options;
      if (!node) {
        return;
      }
      const id = node.getAttribute('data-node-id');
      selectedCaller = id;
      if (pushHistory) {
        navigationHistory = navigationHistory.slice(0, navigationIndex + 1);
        if (navigationHistory[navigationHistory.length - 1] !== id) {
          navigationHistory.push(id);
        }
        navigationIndex = navigationHistory.length - 1;
      }
      applyState();
      focusNodeById(id);
      if (revealLine) {
        const line = Number(node.getAttribute('data-line') || '1');
        vscode.postMessage({ type: 'revealLine', line });
      }
    }

    function navigateHistory(direction) {
      const nextIndex = navigationIndex + direction;
      if (nextIndex < 0 || nextIndex >= navigationHistory.length) {
        return;
      }
      navigationIndex = nextIndex;
      const targetId = navigationHistory[navigationIndex];
      const node = nodes.find((entry) => entry.getAttribute('data-node-id') === targetId);
      if (node) {
        focusNode(node, { pushHistory: false, revealLine: true });
      }
    }

    function updateNavigationUi() {
      navBack.disabled = navigationIndex <= 0;
      navForward.disabled = navigationIndex >= navigationHistory.length - 1;
      focusModeButton.textContent = focusModeEnabled ? 'Focus: On' : 'Focus: Off';
    }

    function runSearchStep() {
      if (!searchMatches.length) {
        return;
      }
      searchIndex = (searchIndex + 1) % searchMatches.length;
      focusNode(searchMatches[searchIndex]);
    }

    function refreshGroupList() {
      const mode = groupMode.value;
      const groups = ((graphData.analysis || {}).groups || {})[mode] || [];
      if (!groups.length) {
        groupList.innerHTML = '<div class="empty">No groups available for this mode.</div>';
        return;
      }

      groupList.innerHTML = groups
        .map((group) => {
          const hidden = collapsedGroupIds.has(group.id);
          const visibleCount = group.nodeIds.filter((id) => {
            const node = nodes.find((entry) => entry.getAttribute('data-node-id') === id);
            return node && !node.classList.contains('hidden');
          }).length;
          return '<div class="group-item' + (hidden ? ' hidden-group' : '') + '">' +
            '<button type="button" data-group-id="' + esc(group.id) + '" class="group-toggle">' +
            '<div class="title-row"><span>' + esc(group.label) + '</span><span>' + (hidden ? 'collapsed' : visibleCount + '/' + group.nodeIds.length) + '</span></div>' +
            '<div class="meta-row">' + esc(group.nodeIds.slice(0, 4).join(', ')) + (group.nodeIds.length > 4 ? ' ...' : '') + '</div>' +
            '</button></div>';
        })
        .join('');

      Array.from(groupList.querySelectorAll('.group-toggle')).forEach((button) => {
        button.addEventListener('click', () => {
          const id = button.getAttribute('data-group-id');
          if (!id) {
            return;
          }
          if (collapsedGroupIds.has(id)) {
            collapsedGroupIds.delete(id);
          } else {
            collapsedGroupIds.add(id);
          }
          applyState();
        });
      });
    }

    nodes.forEach((node) => {
      node.addEventListener('click', () => {
        focusNode(node);
      });
      node.addEventListener('dblclick', () => {
        const line = Number(node.getAttribute('data-line') || '1');
        vscode.postMessage({ type: 'revealLine', line });
      });
    });

    function setZoom(nextScale, clientX, clientY) {
      const prevScale = zoomScale;
      zoomScale = Math.max(minZoom, Math.min(maxZoom, nextScale));
      if (zoomScale === prevScale) {
        return;
      }

      const rect = canvasWrap.getBoundingClientRect();
      const focusX = (clientX ?? rect.left + rect.width / 2) - rect.left + canvasWrap.scrollLeft;
      const focusY = (clientY ?? rect.top + rect.height / 2) - rect.top + canvasWrap.scrollTop;

      const worldX = focusX / prevScale;
      const worldY = focusY / prevScale;

      graphContent.style.transform = 'scale(' + zoomScale + ')';
      zoomLevel.textContent = String(Math.round(zoomScale * 100)) + '%';
      if (zoomPreset) {
        const percent = String(Math.round(zoomScale * 100));
        const hasOption = Array.from(zoomPreset.options).some((o) => o.value === percent);
        if (hasOption) {
          zoomPreset.value = percent;
        }
      }

      const viewportX = (clientX ?? rect.left + rect.width / 2) - rect.left;
      const viewportY = (clientY ?? rect.top + rect.height / 2) - rect.top;
      canvasWrap.scrollLeft = worldX * zoomScale - viewportX;
      canvasWrap.scrollTop = worldY * zoomScale - viewportY;
      persistState();
    }

    function fitGraphToViewport() {
      const svg = document.getElementById('graphSvg');
      if (!svg) {
        return;
      }
      const graphWidth = svg.viewBox.baseVal.width || svg.clientWidth;
      const graphHeight = svg.viewBox.baseVal.height || svg.clientHeight;
      if (!graphWidth || !graphHeight || !canvasWrap.clientWidth || !canvasWrap.clientHeight) {
        return;
      }

      const scaleX = canvasWrap.clientWidth / graphWidth;
      const scaleY = canvasWrap.clientHeight / graphHeight;
      const fitScale = Math.max(minZoom, Math.min(maxZoom, Math.min(scaleX, scaleY)));
      setZoom(fitScale);

      const scaledWidth = graphWidth * zoomScale;
      const scaledHeight = graphHeight * zoomScale;
      canvasWrap.scrollLeft = Math.max(0, (scaledWidth - canvasWrap.clientWidth) / 2);
      canvasWrap.scrollTop = Math.max(0, (scaledHeight - canvasWrap.clientHeight) / 2);
    }

    canvasWrap.addEventListener('wheel', (event) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? 1 / zoomFactor : zoomFactor;
      setZoom(zoomScale * factor, event.clientX, event.clientY);
    }, { passive: false });

    document.getElementById('resetZoom').addEventListener('click', () => {
      fitGraphToViewport();
    });
    document.getElementById('zoomIn').addEventListener('click', () => {
      setZoom(zoomScale * zoomFactor);
    });
    document.getElementById('zoomOut').addEventListener('click', () => {
      setZoom(zoomScale / zoomFactor);
    });
    if (zoomPreset) {
      zoomPreset.addEventListener('change', (event) => {
        const raw = Number(event.target && event.target.value);
        if (!Number.isFinite(raw) || raw <= 0) {
          return;
        }
        setZoom(raw / 100);
      });
    }

    canvasWrap.addEventListener('mousedown', (event) => {
      if (event.button !== 0) {
        return;
      }
      if (event.target && event.target.closest('.node')) {
        return;
      }
      isPanning = true;
      panStartX = event.clientX;
      panStartY = event.clientY;
      panStartScrollLeft = canvasWrap.scrollLeft;
      panStartScrollTop = canvasWrap.scrollTop;
      canvasWrap.classList.add('panning');
    });

    window.addEventListener('mousemove', (event) => {
      if (!isPanning) {
        return;
      }
      const dx = event.clientX - panStartX;
      const dy = event.clientY - panStartY;
      canvasWrap.scrollLeft = panStartScrollLeft - dx;
      canvasWrap.scrollTop = panStartScrollTop - dy;
    });

    window.addEventListener('mouseup', () => {
      if (!isPanning) {
        return;
      }
      isPanning = false;
      canvasWrap.classList.remove('panning');
    });

    let fitTimer = null;
    window.addEventListener('resize', () => {
      if (fitTimer) {
        clearTimeout(fitTimer);
      }
      fitTimer = setTimeout(() => {
        fitGraphToViewport();
      }, 120);
    });

    document.getElementById('downloadSvg').addEventListener('click', () => {
      const serialized = buildExportSvgString();
      vscode.postMessage({ type: 'exportSvg', svg: serialized });
    });

    document.getElementById('exportJson').addEventListener('click', () => {
      vscode.postMessage({ type: 'exportGraphJson' });
    });

    document.getElementById('exportDot').addEventListener('click', () => {
      vscode.postMessage({ type: 'exportDot' });
    });

    document.getElementById('exportExcalidraw').addEventListener('click', () => {
      vscode.postMessage({ type: 'exportExcalidraw' });
    });

    document.getElementById('downloadPng').addEventListener('click', () => {
      const svg = document.getElementById('graphSvg');
      const serialized = buildExportSvgString();
      const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = svg.viewBox.baseVal.width || svg.clientWidth;
        canvas.height = svg.viewBox.baseVal.height || svg.clientHeight;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        const png = canvas.toDataURL('image/png');
        vscode.postMessage({ type: 'exportPng', png });
      };
      img.src = url;
    });

    document.getElementById('searchNext').addEventListener('click', () => {
      runSearchStep();
    });
    document.getElementById('clearSearch').addEventListener('click', () => {
      nodeSearch.value = '';
      searchIndex = -1;
      applyState();
    });
    nodeSearch.addEventListener('input', () => {
      searchIndex = -1;
      applyState();
    });
    nodeSearch.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runSearchStep();
      }
    });

    ['filterCalls', 'filterSignals', 'filterExternal', 'filterTso', 'filterDynamic'].forEach((id) => {
      document.getElementById(id).addEventListener('change', () => {
        applyState();
      });
    });

    groupMode.addEventListener('change', () => {
      collapsedGroupIds = new Set();
      applyState();
    });
    navBack.addEventListener('click', () => {
      navigateHistory(-1);
    });
    navForward.addEventListener('click', () => {
      navigateHistory(1);
    });
    focusModeButton.addEventListener('click', () => {
      focusModeEnabled = !focusModeEnabled;
      applyState();
    });
    toggleViewMode.addEventListener('click', () => {
      viewMode = viewMode === 'graph' ? 'detailed' : 'graph';
      applyViewMode();
      persistState();
    });
    document.getElementById('showAllNodes').addEventListener('click', () => {
      collapsedGroupIds = new Set();
      focusModeEnabled = false;
      applyState();
    });
    document.getElementById('collapseAllGroups').addEventListener('click', () => {
      const groups = ((graphData.analysis || {}).groups || {})[groupMode.value] || [];
      collapsedGroupIds = new Set(groups.map((group) => group.id));
      applyState();
    });
    document.getElementById('expandAllGroups').addEventListener('click', () => {
      collapsedGroupIds = new Set();
      applyState();
    });

    Array.from(document.querySelectorAll('[data-jump-line]')).forEach((button) => {
      button.addEventListener('click', () => {
        const nodeId = button.getAttribute('data-node-id');
        const line = Number(button.getAttribute('data-jump-line') || '1');
        if (nodeId) {
          const node = nodes.find((entry) => entry.getAttribute('data-node-id') === nodeId);
          if (node) {
            focusNode(node);
            return;
          }
        }
        vscode.postMessage({ type: 'revealLine', line });
      });
    });

    function buildExportSvgString() {
      const svg = document.getElementById('graphSvg');
      const clone = svg.cloneNode(true);
      const ns = 'http://www.w3.org/2000/svg';
      const exportNodes = document.createElementNS(ns, 'g');
      exportNodes.setAttribute('id', 'exportNodes');

      nodes.forEach((node) => {
        const x = Number(node.style.left.replace('px', '')) || node.offsetLeft || 0;
        const y = Number(node.style.top.replace('px', '')) || node.offsetTop || 0;
        const width = node.offsetWidth || ${cardWidth};
        const height = node.offsetHeight || ${cardHeight};
        const isSignal = node.classList.contains('signal-handler');

        const rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(width));
        rect.setAttribute('height', String(height));
        rect.setAttribute('rx', '8');
        rect.setAttribute('ry', '8');
        rect.setAttribute('fill', isSignal ? '#fff1f0' : '#ffffff');
        rect.setAttribute('stroke', isSignal ? '#b42318' : '#b8cad8');
        rect.setAttribute('stroke-width', '1');
        exportNodes.appendChild(rect);

        const nameEl = node.querySelector('.name');
        const metaEl = node.querySelector('.meta');
        const nameText = document.createElementNS(ns, 'text');
        nameText.setAttribute('x', String(x + 10));
        nameText.setAttribute('y', String(y + 20));
        nameText.setAttribute('font-size', '13');
        nameText.setAttribute('font-weight', '700');
        nameText.setAttribute('font-family', 'Segoe UI, Arial, sans-serif');
        nameText.setAttribute('fill', isSignal ? '#b42318' : '#cc3f0c');
        nameText.textContent = (nameEl && nameEl.textContent) ? nameEl.textContent : '';
        exportNodes.appendChild(nameText);

        const metaText = document.createElementNS(ns, 'text');
        metaText.setAttribute('x', String(x + 10));
        metaText.setAttribute('y', String(y + 38));
        metaText.setAttribute('font-size', '11');
        metaText.setAttribute('font-family', 'Segoe UI, Arial, sans-serif');
        metaText.setAttribute('fill', '#5f7380');
        metaText.textContent = (metaEl && metaEl.textContent) ? metaEl.textContent : '';
        exportNodes.appendChild(metaText);
      });

      clone.appendChild(exportNodes);
      return new XMLSerializer().serializeToString(clone);
    }

    window.addEventListener('message', (event) => {
      const msg = event && event.data;
      if (!msg || msg.type !== 'selectCaller') {
        return;
      }
      const caller = typeof msg.caller === 'string' ? msg.caller : null;
      const exists = nodes.some((n) => n.getAttribute('data-node-id') === caller);
      selectedCaller = exists ? caller : null;
      applyState();
      if (msg.reveal && selectedCaller) {
        focusNodeById(selectedCaller);
      }
    });

    // Initial fit so graph starts sized to the visible panel area.
    requestAnimationFrame(() => {
      if (persisted.groupMode && Array.from(groupMode.options).some((option) => option.value === persisted.groupMode)) {
        groupMode.value = persisted.groupMode;
      }
      if (persisted.nodeSearch) {
        nodeSearch.value = persisted.nodeSearch;
      }
      if (persisted.filters) {
        document.getElementById('filterCalls').checked = persisted.filters.call !== false;
        document.getElementById('filterSignals').checked = persisted.filters.signal !== false;
        document.getElementById('filterExternal').checked = persisted.filters.external !== false;
        document.getElementById('filterTso').checked = persisted.filters.tso !== false;
        document.getElementById('filterDynamic').checked = persisted.filters.dynamic !== false;
      }
      if (Array.isArray(persisted.collapsedGroupIds)) {
        collapsedGroupIds = new Set(persisted.collapsedGroupIds);
      }
      if (Array.isArray(persisted.navigationHistory)) {
        navigationHistory = persisted.navigationHistory;
      }
      if (typeof persisted.navigationIndex === 'number') {
        navigationIndex = persisted.navigationIndex;
      }
      if (typeof persisted.focusModeEnabled === 'boolean') {
        focusModeEnabled = persisted.focusModeEnabled;
      }
      if (persisted.viewMode === 'graph' || persisted.viewMode === 'detailed') {
        viewMode = persisted.viewMode;
      }
      if (typeof persisted.selectedCaller === 'string') {
        selectedCaller = persisted.selectedCaller;
      }
      applyViewMode();
      applyState();
      fitGraphToViewport();
      if (typeof persisted.zoomScale === 'number' && Number.isFinite(persisted.zoomScale)) {
        setZoom(persisted.zoomScale);
      }
      if (selectedCaller) {
        focusNodeById(selectedCaller);
      }
    });
  </script>
</body>
</html>`;
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
    .filter((n) => targets.has(n.id) && n.id !== "MAIN")
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

function renderDiagnosticsHtml(analysis) {
  const sections = [];
  const unreachable = (analysis.unreachableProcedures || []).map((id) => ({
    title: id,
    meta: "Procedure is not reachable from MAIN.",
    nodeId: id,
    line: findMetricLine(analysis, id)
  }));
  const undefinedLabels = (analysis.undefinedLabels || []).map((item) => ({
    title: item.id,
    meta: `Undefined target from ${item.callers.join(", ") || "unknown caller"}.`,
    nodeId: item.id,
    line: item.line
  }));
  const cycles = (analysis.recursiveCycles || []).map((item) => ({
    title: item.label,
    meta: item.members.join(" -> "),
    nodeId: item.members[0],
    line: item.lines[0]
  }));
  const cleanup = (analysis.cleanupBypassRisks || []).map((item) => ({
    title: item.scope,
    meta: `line ${item.line}: ${item.message}`,
    nodeId: item.scope,
    line: item.line
  }));
  const loopRisks = (analysis.possibleInfiniteLoops || []).map((item) => ({
    title: item.members.join(", "),
    meta: item.message,
    nodeId: item.members[0],
    line: item.lines[0]
  }));
  const deadCode = (analysis.deadCodeStatements || []).map((item) => ({
    title: item.scope,
    meta: `line ${item.line}: unreachable after line ${item.afterLine}.`,
    nodeId: item.scope,
    line: item.line
  }));
  const longLines = (analysis.lineLengthWarnings || []).map((item) => ({
    title: `Line ${item.line}`,
    meta: `${item.length} columns (limit ${item.maxColumns}). ${item.preview}`,
    nodeId: "",
    line: item.line
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
          )}" data-jump-line="${item.line || 1}"><div class="title-row"><span>${escapeHtml(
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
      )}</span><span>CC ${metric.cyclomaticComplexity}</span></div><div class="meta-row">line ${metric.line} • statements ${metric.statementCount} • fan-in ${metric.fanIn} • fan-out ${metric.fanOut} • exits ${metric.exitCount}</div></div>`
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

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
