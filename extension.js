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

    graphDocumentUri = doc.uri;
    graphPanel.title = `REXX Control Flow: ${path.basename(doc.fileName)}`;
    graphPanel.webview.html = renderGraphHtml(graph, doc.fileName, customCss);

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
    if (!event.affectsConfiguration("rexxFlow.customCssFile")) {
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

function renderGraphHtml(graph, fileName, customCss = "") {
  const nodes = graph.nodes;
  const edges = graph.edges;
  const edgeColorByTarget = buildEdgeColorMap(nodes, edges);

  const cardWidth = 170;
  const cardHeight = 56;
  const gapX = 60;
  const gapY = 56;
  const margin = 30;
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

      const edgeColor = edgeColorByTarget.get(edge.to) || "#2f4858";

      return [
        `<g class="edge-group ${classNames}" data-edge-type="${escapeHtml(edge.type)}" data-from="${escapeHtml(
          edge.from
        )}" data-to="${escapeHtml(edge.to)}">`,
        `<line class="edge" style="stroke:${edgeColor}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#arrow)" />`,
        `<text class="edge-label" style="fill:${edgeColor}" x="${mx}" y="${my}">${escapeHtml(edge.type)}</text>`,
        `</g>`
      ].join("");
    })
    .join("\n");

  const nodeHtml = nodes
    .map((node) => {
      const pos = positions.get(node.id);
      return `<button class="node ${nodeClassName(node)}" data-line="${node.line}" data-kind="${escapeHtml(
        node.kind || ""
      )}" data-node-id="${escapeHtml(node.id)}" style="left:${pos.x}px;top:${pos.y}px" title="Click to filter calls, double-click to jump to line ${node.line}"><div class="name">${escapeHtml(
        node.label
      )}</div><div class="meta">line ${node.line}</div></button>`;
    })
    .join("\n");

  const graphTitle = `${escapeHtml(fileName)} | Functions: ${nodes.length} | Calls: ${edges.length}`;

  const customCssBlock = customCss ? `\n  <style id="user-css">\n${sanitizeCss(customCss)}\n  </style>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>REXX Call Graph</title>
  <style>
    :root {
      --bg: #f7f9fb;
      --card: #ffffff;
      --line: #2f4858;
      --ink: #1d2a33;
      --muted: #5f7380;
      --accent: #cc3f0c;
      --border: #d7e0e8;
    }
    body {
      margin: 0;
      background: linear-gradient(145deg, #f7f9fb 0%, #eef3f8 100%);
      color: var(--ink);
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
    }
    .wrap {
      padding: 16px;
    }
    .title {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .subtitle {
      color: var(--muted);
      margin-bottom: 12px;
      font-size: 13px;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    .zoom-pill {
      margin-left: auto;
      font-size: 12px;
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 4px 8px;
      background: #fff;
    }
    .controls button {
      border: 1px solid #96acbc;
      border-radius: 8px;
      background: #fff;
      color: #1e3441;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 12px;
    }
    .canvas {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--card);
      overflow: auto;
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
    .edge {
      stroke: var(--line);
      stroke-width: 1.5;
      opacity: 0.75;
    }
    .edge-label {
      font-size: 10px;
      fill: var(--muted);
      text-anchor: middle;
      paint-order: stroke;
      stroke: #fff;
      stroke-width: 2px;
      stroke-linejoin: round;
    }
    .edge-group.dimmed .edge,
    .edge-group.dimmed .edge-label {
      opacity: 0.3;
    }
    .edge-group.active .edge {
      opacity: 1;
      stroke-width: 2.8;
    }
    .edge-group.active .edge-label {
      opacity: 1;
      font-weight: 700;
    }
    .node {
      position: absolute;
      width: ${cardWidth}px;
      height: ${cardHeight}px;
      border: 1px solid #b8cad8;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 1px 3px rgba(26, 44, 61, 0.08);
      padding: 6px 8px;
      box-sizing: border-box;
      text-align: left;
      cursor: pointer;
    }
    .node:hover {
      border-color: #6d8aa0;
    }
    .node.selected {
      border-color: #1f4f6a;
      box-shadow: 0 0 0 2px rgba(31, 79, 106, 0.18), 0 1px 3px rgba(26, 44, 61, 0.08);
    }
    .node.signal-handler {
      border-color: #b42318;
      background: #fff1f0;
    }
    .node.signal-handler .name {
      color: #b42318;
    }
    .node.signal-handler.selected {
      border-color: #8f1d14;
      box-shadow: 0 0 0 2px rgba(180, 35, 24, 0.24), 0 1px 3px rgba(26, 44, 61, 0.08);
    }
    .node .name {
      font-weight: 700;
      font-size: 13px;
      color: var(--accent);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      pointer-events: none;
    }
    .node .meta {
      margin-top: 4px;
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
  </style>${customCssBlock}
</head>
<body>
  <div class="wrap" id="app">
    <div class="title">REXX Call Graph</div>
    <div class="subtitle">${graphTitle}</div>
    <div class="controls">
      <button id="exportJson" type="button">Export JSON</button>
      <button id="exportDot" type="button">Export DOT</button>
      <button id="exportExcalidraw" type="button">Export Excalidraw</button>
      <button id="downloadSvg" type="button">Export SVG</button>
      <button id="downloadPng" type="button">Export PNG</button>
      <button id="resetZoom" type="button">Reset Zoom</button>
      <div class="zoom-pill">Zoom: <span id="zoomLevel">100%</span></div>
    </div>

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
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const nodes = Array.from(document.querySelectorAll('.node'));
    const edgeGroups = Array.from(document.querySelectorAll('.edge-group'));
    const canvasWrap = document.getElementById('canvasWrap');
    const graphContent = document.getElementById('graphContent');
    const zoomLevel = document.getElementById('zoomLevel');
    let selectedCaller = null;
    let zoomScale = 1;
    const minZoom = 0.4;
    const maxZoom = 2.5;
    const zoomFactor = 1.12;

    function applyCallerFilter() {
      const hasOutgoing = selectedCaller
        ? edgeGroups.some((edge) => edge.getAttribute('data-from') === selectedCaller)
        : false;

      edgeGroups.forEach((edge) => {
        const from = edge.getAttribute('data-from');
        const to = edge.getAttribute('data-to');
        const isActive = !selectedCaller || (hasOutgoing ? from === selectedCaller : to === selectedCaller);
        edge.classList.toggle('active', Boolean(selectedCaller && isActive));
        edge.classList.toggle('dimmed', Boolean(selectedCaller && !isActive));
      });

      nodes.forEach((node) => {
        node.classList.toggle('selected', node.getAttribute('data-node-id') === selectedCaller);
      });
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

    nodes.forEach((node) => {
      node.addEventListener('click', () => {
        const id = node.getAttribute('data-node-id');
        selectedCaller = id;
        applyCallerFilter();
        focusNodeById(id);

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

      const viewportX = (clientX ?? rect.left + rect.width / 2) - rect.left;
      const viewportY = (clientY ?? rect.top + rect.height / 2) - rect.top;
      canvasWrap.scrollLeft = worldX * zoomScale - viewportX;
      canvasWrap.scrollTop = worldY * zoomScale - viewportY;
    }

    canvasWrap.addEventListener('wheel', (event) => {
      event.preventDefault();
      const factor = event.deltaY > 0 ? 1 / zoomFactor : zoomFactor;
      setZoom(zoomScale * factor, event.clientX, event.clientY);
    }, { passive: false });

    document.getElementById('resetZoom').addEventListener('click', () => {
      setZoom(1);
    });

    document.getElementById('downloadSvg').addEventListener('click', () => {
      const svg = document.getElementById('graphSvg');
      const serialized = new XMLSerializer().serializeToString(svg);
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
      const serialized = new XMLSerializer().serializeToString(svg);
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

    window.addEventListener('message', (event) => {
      const msg = event && event.data;
      if (!msg || msg.type !== 'selectCaller') {
        return;
      }
      const caller = typeof msg.caller === 'string' ? msg.caller : null;
      const exists = nodes.some((n) => n.getAttribute('data-node-id') === caller);
      selectedCaller = exists ? caller : null;
      applyCallerFilter();
      if (msg.reveal && selectedCaller) {
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
    "#0b6e4f",
    "#a23b00",
    "#005f99",
    "#6a1b9a",
    "#7a3e00",
    "#00695c",
    "#3f51b5",
    "#ad1457",
    "#2e7d32",
    "#ef6c00"
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
