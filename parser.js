function parseRexxControlFlow(source) {
  const lines = source.split(/\r?\n/);
  const nodes = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const statementBlocks = [];

  upsertNode(nodes, "MAIN", "MAIN", 1, "entry");

  let currentScope = "MAIN";
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const stripped = stripComments(lines[i], { inBlockComment });
    inBlockComment = stripped.inBlockComment;

    const line = collapse(stripped.line);
    if (!line) {
      continue;
    }

    const labelMatch = line.match(/^([A-Za-z0-9_.$!?@#]+)\s*:\s*(.*)$/);
    if (labelMatch) {
      currentScope = normalizeLabel(labelMatch[1]);
      defineNode(nodes, currentScope, currentScope, lineNo, "function");

      const trailing = collapse(labelMatch[2]);
      if (trailing) {
        statementBlocks.push({ text: trailing, lineNo, scope: currentScope });
      }
      continue;
    }

    statementBlocks.push({ text: line, lineNo, scope: currentScope });
  }

  const definedLabels = new Set(
    Array.from(nodes.values())
      .filter((node) => node.kind === "function" || node.kind === "entry")
      .map((node) => node.id)
  );

  for (const block of statementBlocks) {
    processStatementBlock(
      block.text,
      block.lineNo,
      block.scope,
      nodes,
      edges,
      edgeKeys,
      definedLabels
    );
  }

  const nodeList = Array.from(nodes.values()).sort((a, b) => {
    if (a.id === "MAIN") {
      return -1;
    }
    if (b.id === "MAIN") {
      return 1;
    }
    return a.line - b.line || a.id.localeCompare(b.id);
  });

  return { nodes: nodeList, edges };
}

function processStatementBlock(text, lineNo, currentScope, nodes, edges, edgeKeys, definedLabels) {
  for (const segment of splitStatements(text)) {
    const upper = segment.toUpperCase();
    const searchable = maskQuotedText(upper);
    const signalPattern = /\bSIGNAL\b\s+ON\b(?:\s+[A-Z0-9_.$!?@#]+)?\s+NAME\b\s+([A-Z0-9_.$!?@#]+)/g;
    const callPattern = /\bCALL\b\s*(VALUE\b|\(|([A-Z0-9_.$!?@#]+))/g;
    let match;
    let signalMatch;

    while ((signalMatch = signalPattern.exec(searchable)) !== null) {
      const target = normalizeLabel(signalMatch[1]);
      if (!target || target === "ON" || target === "OFF") {
        continue;
      }
      upsertNode(nodes, target, target, lineNo, "reference");
      markSignalHandler(nodes, target);
      addEdge(edges, edgeKeys, currentScope, target, "signal-on", lineNo);
    }

    while ((match = callPattern.exec(searchable)) !== null) {
      if (match[1] === "VALUE" || match[1] === "(") {
        upsertNode(nodes, "DYNAMIC_CALL", "DYNAMIC_CALL", lineNo, "dynamic");
        addEdge(edges, edgeKeys, currentScope, "DYNAMIC_CALL", "calls-dynamic", lineNo);
        continue;
      }

      const target = normalizeLabel(match[2]);
      if (target === "ON" || target === "OFF") {
        continue;
      }

      upsertNode(nodes, target, target, lineNo, "reference");
      addEdge(edges, edgeKeys, currentScope, target, "calls", lineNo);
    }

    const directInvokePattern = /\b([A-Z0-9_.$!?@#]+)\s*\(/g;
    let direct;
    while ((direct = directInvokePattern.exec(searchable)) !== null) {
      const target = normalizeLabel(direct[1]);
      if (!definedLabels || !definedLabels.has(target) || target === "MAIN") {
        continue;
      }
      upsertNode(nodes, target, target, lineNo, "reference");
      addEdge(edges, edgeKeys, currentScope, target, "calls", lineNo);
    }
  }
}

function addEdge(edges, edgeKeys, from, to, type, line) {
  const key = `${from}->${to}:${type}`;
  if (edgeKeys.has(key)) {
    return;
  }
  edgeKeys.add(key);
  edges.push({ from, to, type, line });
}

function upsertNode(nodes, id, label, line, kind) {
  const existing = nodes.get(id);
  if (!existing) {
    nodes.set(id, { id, label, line, kind });
    return;
  }

  if (line < existing.line) {
    existing.line = line;
  }

  if (existing.kind !== "entry" && kind === "function") {
    existing.kind = kind;
  }
}

function defineNode(nodes, id, label, line, kind) {
  const existing = nodes.get(id);
  if (!existing) {
    nodes.set(id, { id, label, line, kind });
    return;
  }

  // When a true label definition is found, bind the node to that line.
  existing.line = line;
  if (existing.kind !== "entry") {
    existing.kind = kind;
  }
}

function markSignalHandler(nodes, id) {
  const existing = nodes.get(id);
  if (!existing) {
    nodes.set(id, { id, label: id, line: 1, kind: "reference", isSignalHandler: true });
    return;
  }
  existing.isSignalHandler = true;
}

function normalizeLabel(label) {
  return String(label).trim().toUpperCase();
}

function collapse(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function stripComments(line, state) {
  let inBlockComment = state.inBlockComment;
  let result = "";

  for (let i = 0; i < line.length; i += 1) {
    const pair = line.slice(i, i + 2);
    if (!inBlockComment && pair === "/*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (inBlockComment && pair === "*/") {
      inBlockComment = false;
      i += 1;
      continue;
    }
    if (!inBlockComment) {
      result += line[i];
    }
  }

  return { line: result, inBlockComment };
}

function splitStatements(text) {
  const out = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === ";") {
      const stmt = collapse(current);
      if (stmt) {
        out.push(stmt);
      }
      current = "";
      continue;
    }

    current += ch;
  }

  const tail = collapse(current);
  if (tail) {
    out.push(tail);
  }

  return out;
}

function maskQuotedText(text) {
  let out = "";
  let quote = null;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += " ";
      continue;
    }
    out += ch;
  }

  return out;
}

function toDot(graph) {
  const out = ["digraph REXXControlFlow {", "  rankdir=TB;"];

  for (const node of graph.nodes) {
    out.push(`  \"${escapeDot(node.id)}\" [label=\"${escapeDot(node.label)}\"];`);
  }

  for (const edge of graph.edges) {
    out.push(
      `  \"${escapeDot(edge.from)}\" -> \"${escapeDot(edge.to)}\" [label=\"${escapeDot(edge.type)}\"];`
    );
  }

  out.push("}");
  return out.join("\n");
}

function escapeDot(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\"/g, '\\\"');
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

function toExcalidraw(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const now = Date.now();

  const maxLabelLen = Math.max(8, ...nodes.map((node) => String(node.label || node.id || "").length));
  const cardWidth = Math.min(320, Math.max(210, Math.round(140 + maxLabelLen * 7)));
  const cardHeight = 76;
  const gapX = Math.max(150, Math.round(cardWidth * 0.72));
  const gapY = 130;
  const margin = 80;
  const layers = buildNorthSouthLayers(nodes, edges);
  const cols = Math.max(1, ...layers.map((layer) => layer.length));

  const nodeLayout = new Map();
  const nodeIdToElementId = new Map();
  const nodeRectangles = new Map();
  const allElements = [];

  let nodeIndex = 0;
  layers.forEach((layer, row) => {
    const rowWidth = layer.length * cardWidth + Math.max(0, layer.length - 1) * gapX;
    const xStart = margin + Math.max(0, Math.round((cols * (cardWidth + gapX) - gapX - rowWidth) / 2));
    layer.forEach((node, col) => {
      nodeIndex += 1;
      const x = xStart + col * (cardWidth + gapX);
      const y = margin + row * (cardHeight + gapY);
      const elementId = `node_${nodeIndex}`;
      nodeLayout.set(node.id, { x, y });
      nodeIdToElementId.set(node.id, elementId);
    });
  });

  nodes.forEach((node, idx) => {
    const rectId = nodeIdToElementId.get(node.id);
    const textId = `node_text_${idx + 1}`;
    const pos = nodeLayout.get(node.id);
    const label = String(node.label || node.id || "");
    const fontSize = 18;
    const lineHeight = 1.2;
    const textHeight = Math.round(fontSize * lineHeight);
    const approxCharWidth = Math.round(fontSize * 0.6);
    const textWidth = Math.max(24, Math.min(cardWidth - 20, label.length * approxCharWidth));
    const textX = pos.x + Math.max(10, Math.round((cardWidth - textWidth) / 2));
    const textY = pos.y + Math.round((cardHeight - textHeight) / 2);

    const rect = {
      id: rectId,
      type: "rectangle",
      x: pos.x,
      y: pos.y,
      width: cardWidth,
      height: cardHeight,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "#ffffff",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: 1000 + idx,
      version: 1,
      versionNonce: 2000 + idx,
      isDeleted: false,
      boundElements: [{ type: "text", id: textId }],
      updated: now,
      link: null,
      locked: false
    };
    nodeRectangles.set(node.id, rect);
    allElements.push(rect);

    allElements.push({
      id: textId,
      type: "text",
      x: textX,
      y: textY,
      width: textWidth,
      height: textHeight,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 3000 + idx,
      version: 1,
      versionNonce: 4000 + idx,
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
      text: label,
      fontSize,
      fontFamily: 3,
      textAlign: "center",
      verticalAlign: "middle",
      baseline: Math.round(fontSize * 0.8),
      containerId: rectId,
      originalText: label,
      lineHeight
    });
  });

  edges.forEach((edge, idx) => {
    const fromElementId = nodeIdToElementId.get(edge.from);
    const toElementId = nodeIdToElementId.get(edge.to);
    const fromPos = nodeLayout.get(edge.from);
    const toPos = nodeLayout.get(edge.to);

    if (!fromElementId || !toElementId || !fromPos || !toPos) {
      return;
    }

    const fromCenterX = fromPos.x + cardWidth / 2;
    const fromCenterY = fromPos.y + cardHeight / 2;
    const toCenterX = toPos.x + cardWidth / 2;
    const toCenterY = toPos.y + cardHeight / 2;
    const deltaX = toCenterX - fromCenterX;
    const deltaY = toCenterY - fromCenterY;

    let startX = fromCenterX;
    let startY = fromCenterY;
    let endX = toCenterX;
    let endY = toCenterY;

    if (Math.abs(deltaY) >= Math.abs(deltaX)) {
      startY = fromPos.y + (deltaY >= 0 ? cardHeight : 0);
      endY = toPos.y + (deltaY >= 0 ? 0 : cardHeight);
    } else {
      startX = fromPos.x + (deltaX >= 0 ? cardWidth : 0);
      endX = toPos.x + (deltaX >= 0 ? 0 : cardWidth);
    }

    const dx = Math.round(endX - startX);
    const dy = Math.round(endY - startY);
    const arrowId = `edge_${idx + 1}`;

    allElements.push({
      id: arrowId,
      type: "arrow",
      x: Math.round(startX),
      y: Math.round(startY),
      width: Math.abs(dx),
      height: Math.abs(dy),
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 2 },
      seed: 5000 + idx,
      version: 1,
      versionNonce: 6000 + idx,
      isDeleted: false,
      boundElements: null,
      updated: now,
      link: null,
      locked: false,
      points: [
        [0, 0],
        [dx, dy]
      ],
      lastCommittedPoint: null,
      startBinding: { elementId: fromElementId, focus: 0, gap: 8 },
      endBinding: { elementId: toElementId, focus: 0, gap: 8 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false
    });

    const fromRect = nodeRectangles.get(edge.from);
    const toRect = nodeRectangles.get(edge.to);
    if (fromRect?.boundElements) {
      fromRect.boundElements.push({ type: "arrow", id: arrowId });
    }
    if (toRect?.boundElements) {
      toRect.boundElements.push({ type: "arrow", id: arrowId });
    }
  });

  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "https://github.com/chipset/rexx-flow-control",
      elements: allElements,
      appState: {
        viewBackgroundColor: "#ffffff",
        gridSize: null
      },
      files: {}
    },
    null,
    2
  );
}

module.exports = {
  parseRexxControlFlow,
  toDot,
  toExcalidraw
};
