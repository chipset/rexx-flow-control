const vscode = require("vscode");
const path = require("node:path");
const { parseRexxControlFlow, toDot } = require("./parser");

const SUPPORTED_LANGS = new Set(["rexx", "REXX"]);

function activate(context) {
  let graphPanel = null;
  let graphDocumentUri = null;

  const renderForDocument = (doc) => {
    const graph = parseRexxControlFlow(doc.getText());
    if (!graphPanel) {
      graphPanel = vscode.window.createWebviewPanel(
        "rexxControlFlow",
        `REXX Control Flow: ${path.basename(doc.fileName)}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );

      graphPanel.onDidDispose(() => {
        graphPanel = null;
        graphDocumentUri = null;
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
        }
      });
    }

    graphDocumentUri = doc.uri;
    graphPanel.title = `REXX Control Flow: ${path.basename(doc.fileName)}`;
    graphPanel.webview.html = renderGraphHtml(graph, doc.fileName);
  };

  const show = vscode.commands.registerCommand("rexxFlow.showControlGraph", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupported(editor.document)) {
      vscode.window.showWarningMessage("Open a REXX file to generate control flow.");
      return;
    }

    renderForDocument(editor.document);
  });

  const exportJson = vscode.commands.registerCommand("rexxFlow.exportGraphJson", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupported(editor.document)) {
      vscode.window.showWarningMessage("Open a REXX file to export control flow.");
      return;
    }

    const graph = parseRexxControlFlow(editor.document.getText());
    const doc = await vscode.workspace.openTextDocument({
      content: JSON.stringify(graph, null, 2),
      language: "json"
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  });

  const exportDot = vscode.commands.registerCommand("rexxFlow.exportDot", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupported(editor.document)) {
      vscode.window.showWarningMessage("Open a REXX file to export control flow.");
      return;
    }

    const graph = parseRexxControlFlow(editor.document.getText());
    const doc = await vscode.workspace.openTextDocument({
      content: toDot(graph),
      language: "dot"
    });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  });

  const onDocumentChange = vscode.workspace.onDidChangeTextDocument((event) => {
    if (!graphPanel || !graphDocumentUri) {
      return;
    }
    if (event.document.uri.toString() !== graphDocumentUri.toString()) {
      return;
    }
    renderForDocument(event.document);
  });

  context.subscriptions.push(show, exportJson, exportDot, onDocumentChange);
}

function isSupported(doc) {
  if (SUPPORTED_LANGS.has(doc.languageId)) {
    return true;
  }
  const name = doc.fileName.toLowerCase();
  return name.endsWith(".rexx") || name.endsWith(".rex") || name.endsWith(".exec");
}

function renderGraphHtml(graph, fileName) {
  const nodes = graph.nodes;
  const edges = graph.edges;
  const edgeColorByTarget = buildEdgeColorMap(nodes, edges);

  const cardWidth = 170;
  const cardHeight = 56;
  const gapX = 60;
  const gapY = 56;
  const cols = Math.max(3, Math.ceil(Math.sqrt(Math.max(nodes.length, 1))));

  const positions = new Map();
  nodes.forEach((node, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = 30 + col * (cardWidth + gapX);
    const y = 30 + row * (cardHeight + gapY);
    positions.set(node.id, { x, y });
  });

  const totalRows = Math.ceil(nodes.length / cols);
  const width = Math.max(720, 60 + cols * (cardWidth + gapX));
  const height = Math.max(420, 60 + totalRows * (cardHeight + gapY));

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
    .canvas {
      position: relative;
      width: ${width}px;
      height: ${height}px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--card);
      overflow: auto;
    }
    .canvas svg {
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
      opacity: 0.12;
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
  </style>
</head>
<body>
  <div class="wrap" id="app">
    <div class="title">REXX Call Graph</div>
    <div class="subtitle">${graphTitle}</div>

    <div class="canvas" id="canvasWrap">
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

  <script>
    const vscode = acquireVsCodeApi();

    const nodes = Array.from(document.querySelectorAll('.node'));
    const edgeGroups = Array.from(document.querySelectorAll('.edge-group'));
    let selectedCaller = null;

    function applyCallerFilter() {
      edgeGroups.forEach((edge) => {
        const from = edge.getAttribute('data-from');
        const isActive = !selectedCaller || from === selectedCaller;
        edge.classList.toggle('active', Boolean(selectedCaller && isActive));
        edge.classList.toggle('dimmed', Boolean(selectedCaller && !isActive));
      });

      nodes.forEach((node) => {
        node.classList.toggle('selected', node.getAttribute('data-node-id') === selectedCaller);
      });
    }

    nodes.forEach((node) => {
      node.addEventListener('click', () => {
        const id = node.getAttribute('data-node-id');
        selectedCaller = selectedCaller === id ? null : id;
        applyCallerFilter();
      });

      node.addEventListener('dblclick', () => {
        const line = Number(node.getAttribute('data-line') || '1');
        vscode.postMessage({ type: 'revealLine', line });
      });
    });

    function downloadBlob(filename, blob, mime) {
      const url = URL.createObjectURL(new Blob([blob], { type: mime }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    }

    document.getElementById('graphSvg').addEventListener('dblclick', () => {
      const svg = document.getElementById('graphSvg');
      const serialized = new XMLSerializer().serializeToString(svg);
      downloadBlob('rexx-control-flow.svg', serialized, 'image/svg+xml');
    });
  </script>
</body>
</html>`;
}

function nodeClassName(node) {
  const kind = (node.kind || "").toLowerCase();
  if (!kind) {
    return "";
  }
  return `kind-${kind.replace(/[^a-z0-9_-]/g, "-")}`;
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
