function parseRexxControlFlow(source) {
  const lines = source.split(/\r?\n/);
  const nodes = new Map();
  const edges = [];
  const edgeKeys = new Set();

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
      upsertNode(nodes, currentScope, currentScope, lineNo, "function");

      const trailing = collapse(labelMatch[2]);
      if (trailing) {
        processStatementBlock(trailing, lineNo, currentScope, nodes, edges, edgeKeys);
      }
      continue;
    }

    processStatementBlock(line, lineNo, currentScope, nodes, edges, edgeKeys);
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

function processStatementBlock(text, lineNo, currentScope, nodes, edges, edgeKeys) {
  for (const segment of splitStatements(text)) {
    const upper = segment.toUpperCase();
    const callPattern = /\bCALL\b\s*(VALUE\b|\(|([A-Z0-9_.$!?@#]+))/g;
    let match;

    while ((match = callPattern.exec(upper)) !== null) {
      if (match[1] === "VALUE" || match[1] === "(") {
        upsertNode(nodes, "DYNAMIC_CALL", "DYNAMIC_CALL", lineNo, "dynamic");
        addEdge(edges, edgeKeys, currentScope, "DYNAMIC_CALL", "calls-dynamic", lineNo);
        continue;
      }

      const target = normalizeLabel(match[2]);
      if (target === "ON" || target === "OFF") {
        continue;
      }

      upsertNode(nodes, target, target, lineNo, "function");
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

function toDot(graph) {
  const out = ["digraph REXXControlFlow {", "  rankdir=LR;"];

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

module.exports = {
  parseRexxControlFlow,
  toDot
};
