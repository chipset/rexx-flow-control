const path = require("node:path");

function getLineText(doc, zeroBasedLine) {
  if (typeof doc.lineAt === "function") {
    return doc.lineAt(zeroBasedLine).text;
  }
  const lines = String(doc.getText ? doc.getText() : "").split(/\r?\n/);
  return lines[zeroBasedLine] || "";
}

function createLineRange(vscode, doc, oneBasedLine) {
  const zeroBasedLine = Math.max(0, Math.min((doc.lineCount || 1) - 1, oneBasedLine - 1));
  const text = getLineText(doc, zeroBasedLine);
  return new vscode.Range(
    new vscode.Position(zeroBasedLine, 0),
    new vscode.Position(zeroBasedLine, text.length)
  );
}

function metricLineForProcedure(analysis, id) {
  return (analysis.metrics || []).find((metric) => metric.id === id)?.line || 1;
}

function buildDiagnosticsForGraph(vscode, doc, graph) {
  const diagnostics = [];
  const analysis = graph.analysis || {};
  const pushDiagnostic = (line, message, severity, code) => {
    const diagnostic = new vscode.Diagnostic(
      createLineRange(vscode, doc, line),
      message,
      severity
    );
    diagnostic.source = "rexxFlow";
    diagnostic.code = code;
    diagnostics.push(diagnostic);
  };

  for (const item of analysis.undefinedLabels || []) {
    pushDiagnostic(
      item.line || 1,
      `Undefined label: ${item.id}. Called from ${item.callers.join(", ") || "unknown scope"}.`,
      vscode.DiagnosticSeverity.Error,
      "undefined-label"
    );
  }
  for (const id of analysis.unreachableProcedures || []) {
    pushDiagnostic(
      metricLineForProcedure(analysis, id),
      `Procedure ${id} is unreachable from MAIN.`,
      vscode.DiagnosticSeverity.Warning,
      "unreachable-procedure"
    );
  }
  for (const item of analysis.cleanupBypassRisks || []) {
    pushDiagnostic(
      item.line || 1,
      item.message,
      vscode.DiagnosticSeverity.Warning,
      "cleanup-bypass-risk"
    );
  }
  for (const item of analysis.possibleInfiniteLoops || []) {
    pushDiagnostic(
      item.lines?.[0] || 1,
      item.message,
      vscode.DiagnosticSeverity.Warning,
      "loop-risk"
    );
  }
  for (const item of analysis.deadCodeStatements || []) {
    pushDiagnostic(
      item.line || 1,
      `Dead code in ${item.scope}: ${item.statement}`,
      vscode.DiagnosticSeverity.Warning,
      "dead-code"
    );
  }
  for (const item of analysis.lineLengthWarnings || []) {
    pushDiagnostic(
      item.line || 1,
      `${item.length} columns exceeds ${item.maxColumns}.`,
      vscode.DiagnosticSeverity.Information,
      "line-length"
    );
  }

  return diagnostics;
}

function buildKindGroups(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const kind = node.kind || "unknown";
    const id = `kind:${kind}`;
    if (!groups.has(id)) {
      groups.set(id, { id, label: kind, nodeIds: [] });
    }
    groups.get(id).nodeIds.push(node.id);
  }
  return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function recomputeWorkspaceReachability(nodes, edges) {
  const adjacency = new Map();
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) {
      continue;
    }
    adjacency.get(edge.from).push(edge.to);
  }

  const reachable = new Set(["WORKSPACE"]);
  const queue = ["WORKSPACE"];
  while (queue.length) {
    const current = queue.shift();
    for (const next of adjacency.get(current) || []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  const unreachableProcedures = [];
  const orphanProcedures = [];
  for (const node of nodes) {
    if (node.id === "WORKSPACE") {
      continue;
    }
    const isProcedure =
      node.kind === "function" || node.kind === "entry" || node.kind === "file-entry";
    if (!isProcedure) {
      continue;
    }
    if (!reachable.has(node.id)) {
      unreachableProcedures.push(node.id);
      if (node.kind === "function" && !node.isSignalHandler) {
        orphanProcedures.push(node.id);
      }
    }
  }

  return { unreachableProcedures, orphanProcedures };
}

function resolveCrossFileCalls({ nodes, edges, analysis }) {
  const edgeKeys = new Set(edges.map((edge) => `${edge.from}->${edge.to}:${edge.type}`));
  const candidateTargets = new Map();
  const metricById = new Map((analysis.metrics || []).map((metric) => [metric.id, metric]));
  const metricIncoming = new Map();
  const metricOutgoing = new Map();

  for (const metric of analysis.metrics || []) {
    metricIncoming.set(metric.id, new Set());
    metricOutgoing.set(metric.id, new Set());
  }
  for (const edge of edges) {
    if (metricIncoming.has(edge.to)) {
      metricIncoming.get(edge.to).add(edge.from);
    }
    if (metricOutgoing.has(edge.from)) {
      metricOutgoing.get(edge.from).add(edge.to);
    }
  }

  for (const node of nodes) {
    if (!["function", "entry", "file-entry"].includes(node.kind)) {
      continue;
    }
    const sourceId = node.sourceId || node.id;
    if (sourceId === "MAIN") {
      continue;
    }
    if (!candidateTargets.has(sourceId)) {
      candidateTargets.set(sourceId, []);
    }
    candidateTargets.get(sourceId).push(node);
  }

  const unresolvedLabels = [];
  const unresolvedSuspicious = [];
  const suspiciousById = new Map((analysis.suspiciousCallTargets || []).map((item) => [item.id, item]));

  for (const item of analysis.undefinedLabels || []) {
    const sourceLabel = item.sourceId || item.id.split("::").pop() || item.id;
    const candidates = (candidateTargets.get(sourceLabel) || []).filter(
      (node) => node.fileLabel !== item.fileLabel
    );
    if (candidates.length !== 1) {
      unresolvedLabels.push(item);
      if (suspiciousById.has(item.id)) {
        unresolvedSuspicious.push(suspiciousById.get(item.id));
      }
      continue;
    }

    const target = candidates[0];
    for (const caller of item.callers || []) {
      const fromId = `${item.fileLabel}::${caller}`;
      const key = `${fromId}->${target.id}:calls-cross-file`;
      if (edgeKeys.has(key)) {
        continue;
      }
      edgeKeys.add(key);
      edges.push({ from: fromId, to: target.id, type: "calls-cross-file", line: item.line || 1 });
      if (metricOutgoing.has(fromId)) {
        metricOutgoing.get(fromId).add(target.id);
      }
      if (metricIncoming.has(target.id)) {
        metricIncoming.get(target.id).add(fromId);
      }
    }
  }

  analysis.undefinedLabels = unresolvedLabels;
  analysis.suspiciousCallTargets = unresolvedSuspicious;

  for (const [id, metric] of metricById.entries()) {
    metric.fanIn = (metricIncoming.get(id) || new Set()).size;
    metric.fanOut = (metricOutgoing.get(id) || new Set()).size;
  }

  const reachability = recomputeWorkspaceReachability(nodes, edges);
  analysis.unreachableProcedures = reachability.unreachableProcedures;
  analysis.orphanProcedures = reachability.orphanProcedures;
}

function buildWorkspaceGraph({ docs, workspaceFolder, getGraphForDocument }) {
  const workspaceLabel = workspaceFolder?.name || "Workspace";
  const workspaceUri = workspaceFolder?.uri?.toString?.() || "workspace:root";
  const nodes = [
    {
      id: "WORKSPACE",
      label: workspaceLabel,
      line: 1,
      kind: "workspace-root",
      flags: [],
      fileId: "file:workspace",
      fileLabel: workspaceLabel,
      fileUri: workspaceUri,
      sectionId: "workspace",
      sectionLabel: "Workspace",
      cycleId: ""
    }
  ];
  const edges = [];
  const fileGroups = [{ id: "file:workspace", label: workspaceLabel, nodeIds: ["WORKSPACE"] }];
  const sectionGroups = new Map();
  const cycleGroups = new Map();
  const groupLabels = new Map();
  const groupMapSection = new Map([["WORKSPACE", "workspace"]]);
  const groupMapCycle = new Map();
  const analysis = {
    roots: ["WORKSPACE"],
    unreachableProcedures: [],
    orphanProcedures: [],
    undefinedLabels: [],
    suspiciousCallTargets: [],
    recursiveCycles: [],
    possibleInfiniteLoops: [],
    deadCodeStatements: [],
    lineLengthWarnings: [],
    cleanupBypassRisks: [],
    metrics: [],
    procedures: [],
    groups: { file: [], kind: [], section: [], cycle: [] },
    groupMap: { section: groupMapSection, cycle: groupMapCycle },
    groupLabels,
    cycleMembers: []
  };

  const mapNodeId = (relativePath, nodeId) => `${relativePath}::${nodeId}`;

  for (const doc of docs) {
    const relativePath =
      workspaceFolder?.uri?.fsPath
        ? path.relative(workspaceFolder.uri.fsPath, doc.fileName) || path.basename(doc.fileName)
        : path.basename(doc.fileName);
    const fileGroupId = `file:${relativePath}`;
    const fileNodeIds = [];
      const graph = getGraphForDocument(doc);

      for (const node of graph.nodes) {
        const mappedId = mapNodeId(relativePath, node.id);
      const sectionId = node.sectionId ? `${fileGroupId}:section:${node.sectionId}` : "";
      const cycleId = node.cycleId ? `${fileGroupId}:cycle:${node.cycleId}` : "";
      nodes.push({
        ...node,
          id: mappedId,
          sourceId: node.id,
          label: node.id === "MAIN" ? relativePath : node.label,
        kind: node.id === "MAIN" ? "file-entry" : node.kind,
        fileId: fileGroupId,
        fileLabel: relativePath,
        fileUri: doc.uri.toString(),
        sectionId,
        sectionLabel: sectionId ? node.sectionLabel || "Section" : "",
        cycleId
      });
      fileNodeIds.push(mappedId);

      if (sectionId) {
        if (!sectionGroups.has(sectionId)) {
          sectionGroups.set(sectionId, {
            id: sectionId,
            label: `${relativePath} • ${node.sectionLabel || node.sectionId || "Section"}`,
            nodeIds: []
          });
        }
        sectionGroups.get(sectionId).nodeIds.push(mappedId);
        groupLabels.set(sectionId, sectionGroups.get(sectionId).label);
        groupMapSection.set(mappedId, sectionId);
      }

      if (cycleId) {
        if (!cycleGroups.has(cycleId)) {
          cycleGroups.set(cycleId, {
            id: cycleId,
            label: `${relativePath} • ${node.cycleId}`,
            nodeIds: []
          });
        }
        cycleGroups.get(cycleId).nodeIds.push(mappedId);
        groupLabels.set(cycleId, cycleGroups.get(cycleId).label);
        groupMapCycle.set(mappedId, cycleId);
      }
    }

    fileGroups.push({ id: fileGroupId, label: relativePath, nodeIds: fileNodeIds });
    edges.push({ from: "WORKSPACE", to: mapNodeId(relativePath, "MAIN"), type: "workspace", line: 1 });
    for (const edge of graph.edges) {
      edges.push({
        ...edge,
        from: mapNodeId(relativePath, edge.from),
        to: mapNodeId(relativePath, edge.to)
      });
    }

    for (const item of graph.analysis.undefinedLabels || []) {
      analysis.undefinedLabels.push({
        ...item,
        id: mapNodeId(relativePath, item.id),
        sourceId: item.id,
        fileLabel: relativePath,
        fileUri: doc.uri.toString()
      });
    }
    for (const item of graph.analysis.suspiciousCallTargets || []) {
      analysis.suspiciousCallTargets.push({
        ...item,
        id: mapNodeId(relativePath, item.id),
        fileLabel: relativePath,
        fileUri: doc.uri.toString()
      });
    }
    for (const id of graph.analysis.unreachableProcedures || []) {
      analysis.unreachableProcedures.push(mapNodeId(relativePath, id));
    }
    for (const id of graph.analysis.orphanProcedures || []) {
      analysis.orphanProcedures.push(mapNodeId(relativePath, id));
    }
    for (const item of graph.analysis.recursiveCycles || []) {
      const mappedCycleId = `${fileGroupId}:cycle:${item.id}`;
      analysis.recursiveCycles.push({
        ...item,
        id: mappedCycleId,
        label: `${relativePath} • ${item.label}`,
        members: item.members.map((member) => mapNodeId(relativePath, member)),
        fileUri: doc.uri.toString()
      });
    }
    for (const item of graph.analysis.possibleInfiniteLoops || []) {
      analysis.possibleInfiniteLoops.push({
        ...item,
        members: item.members.map((member) => mapNodeId(relativePath, member)),
        fileLabel: relativePath,
        fileUri: doc.uri.toString()
      });
    }
    for (const item of graph.analysis.deadCodeStatements || []) {
      analysis.deadCodeStatements.push({
        ...item,
        scope: mapNodeId(relativePath, item.scope),
        fileLabel: relativePath,
        fileUri: doc.uri.toString()
      });
    }
    for (const item of graph.analysis.lineLengthWarnings || []) {
      analysis.lineLengthWarnings.push({
        ...item,
        fileLabel: relativePath,
        fileUri: doc.uri.toString()
      });
    }
    for (const item of graph.analysis.cleanupBypassRisks || []) {
      analysis.cleanupBypassRisks.push({
        ...item,
        scope: mapNodeId(relativePath, item.scope),
        fileLabel: relativePath,
        fileUri: doc.uri.toString()
      });
    }
    for (const item of graph.analysis.metrics || []) {
      analysis.metrics.push({
        ...item,
        id: mapNodeId(relativePath, item.id),
        fileLabel: relativePath,
        fileUri: doc.uri.toString()
      });
    }
    for (const item of graph.analysis.procedures || []) {
      analysis.procedures.push({
        ...item,
        id: mapNodeId(relativePath, item.id),
        fileLabel: relativePath,
        fileUri: doc.uri.toString()
      });
    }
  }

  analysis.groups.file = fileGroups;
  analysis.groups.kind = buildKindGroups(nodes);
  analysis.groups.section = Array.from(sectionGroups.values()).sort((a, b) => a.label.localeCompare(b.label));
  analysis.groups.cycle = Array.from(cycleGroups.values()).sort((a, b) => a.label.localeCompare(b.label));
  analysis.cycleMembers = analysis.recursiveCycles.flatMap((cycle) => cycle.members);
  resolveCrossFileCalls({ nodes, edges, analysis });

  return { nodes, edges, analysis };
}

function getFunctionAtLine(graph, lineNo) {
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
}

module.exports = {
  buildDiagnosticsForGraph,
  buildWorkspaceGraph,
  createLineRange,
  getFunctionAtLine,
  recomputeWorkspaceReachability
};
