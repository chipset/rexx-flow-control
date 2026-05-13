function parseRexxControlFlow(source) {
  const lines = source.split(/\r?\n/);
  const nodes = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const statementBlocks = [];
  const scopeStatements = new Map();
  const scopeExitStatements = new Map();
  const referenceSites = new Map();

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

  processStatementBlocks(statementBlocks, {
    nodes,
    edges,
    edgeKeys,
    definedLabels,
    scopeStatements,
    scopeExitStatements,
    referenceSites
  });

  const nodeList = Array.from(nodes.values()).sort((a, b) => {
    if (a.id === "MAIN") {
      return -1;
    }
    if (b.id === "MAIN") {
      return 1;
    }
    return a.line - b.line || a.id.localeCompare(b.id);
  });

  const analysis = analyzeGraph(
    nodeList,
    edges,
    scopeStatements,
    scopeExitStatements,
    referenceSites,
    lines
  );
  for (const node of nodeList) {
    node.sectionId = analysis.groupMap.section.get(node.id) || "ungrouped";
    node.sectionLabel = analysis.groupLabels.get(node.sectionId) || "Ungrouped";
    node.cycleId = analysis.groupMap.cycle.get(node.id) || "";
    node.flags = buildNodeFlags(node.id, analysis);
  }

  return { nodes: nodeList, edges, analysis };
}

function processStatementBlocks(
  blocks,
  { nodes, edges, edgeKeys, definedLabels, scopeStatements, scopeExitStatements, referenceSites }
) {
  let pendingTso = null;

  for (const block of blocks) {
    for (const segment of splitStatements(block.text)) {
      if (pendingTso && pendingTso.scope === block.scope) {
        pendingTso.text = `${pendingTso.text} ${collapse(segment)}`.trim();
        if (hasBalancedDoubleQuotes(pendingTso.text)) {
          addTsoCommandNode(nodes, edges, edgeKeys, pendingTso.scope, pendingTso.text, pendingTso.lineNo);
          pendingTso = null;
        }
      } else if (isPotentialTsoCommandStart(segment)) {
        const candidate = collapse(segment);
        if (hasBalancedDoubleQuotes(candidate)) {
          addTsoCommandNode(nodes, edges, edgeKeys, block.scope, candidate, block.lineNo);
        } else {
          pendingTso = { scope: block.scope, text: candidate, lineNo: block.lineNo };
        }
      }

      recordScopeStatement(scopeStatements, block.scope, segment, block.lineNo);
      maybeRecordExitRisk(scopeExitStatements, block.scope, segment, block.lineNo);

      const externalCalls = extractAddressLinkmvsTargets(segment);
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
        upsertNode(nodes, target, target, block.lineNo, "reference");
        markSignalHandler(nodes, target);
        addEdge(edges, edgeKeys, block.scope, target, "signal-on", block.lineNo);
        recordReference(referenceSites, target, block.scope, block.lineNo, "signal-on");
      }

      for (const targetText of externalCalls) {
        const normalizedTarget = normalizeExternalTarget(targetText);
        if (!normalizedTarget) {
          continue;
        }
        const nodeId = `LINKMVS:${normalizedTarget}`;
        upsertNode(nodes, nodeId, targetText, block.lineNo, "external-program");
        addEdge(edges, edgeKeys, block.scope, nodeId, "external-call", block.lineNo);
      }

      while ((match = callPattern.exec(searchable)) !== null) {
        if (match[1] === "VALUE" || match[1] === "(") {
          upsertNode(nodes, "DYNAMIC_CALL", "DYNAMIC_CALL", block.lineNo, "dynamic");
          addEdge(edges, edgeKeys, block.scope, "DYNAMIC_CALL", "calls-dynamic", block.lineNo);
          continue;
        }

        const target = normalizeLabel(match[2]);
        if (target === "ON" || target === "OFF") {
          continue;
        }

        upsertNode(nodes, target, target, block.lineNo, "reference");
        addEdge(edges, edgeKeys, block.scope, target, "calls", block.lineNo);
        recordReference(referenceSites, target, block.scope, block.lineNo, "calls");
      }

      const directInvokePattern = /\b([A-Z0-9_.$!?@#]+)\s*\(/g;
      let direct;
      while ((direct = directInvokePattern.exec(searchable)) !== null) {
        const target = normalizeLabel(direct[1]);
        if (!definedLabels || !definedLabels.has(target) || target === "MAIN") {
          continue;
        }
        upsertNode(nodes, target, target, block.lineNo, "reference");
        addEdge(edges, edgeKeys, block.scope, target, "calls", block.lineNo);
        recordReference(referenceSites, target, block.scope, block.lineNo, "calls");
      }
    }
  }

  if (pendingTso) {
    addTsoCommandNode(nodes, edges, edgeKeys, pendingTso.scope, pendingTso.text, pendingTso.lineNo);
  }
}

function analyzeGraph(nodes, edges, scopeStatements, scopeExitStatements, referenceSites, sourceLines = []) {
  const definedProcedureIds = new Set(
    nodes.filter((node) => node.kind === "function" || node.kind === "entry").map((node) => node.id)
  );
  const procedureNodes = nodes.filter(
    (node) =>
      node.kind === "function" || node.kind === "entry" || (node.kind === "reference" && definedProcedureIds.has(node.id))
  );
  const procedureIds = new Set(procedureNodes.map((node) => node.id));

  const outgoing = new Map();
  const incoming = new Map();
  for (const node of procedureNodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }

  for (const edge of edges) {
    if (!procedureIds.has(edge.from) || !procedureIds.has(edge.to)) {
      continue;
    }
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
  }

  const reachable = walkReachable("MAIN", outgoing);
  const unreachableProcedures = procedureNodes
    .filter((node) => node.id !== "MAIN" && !reachable.has(node.id))
    .map((node) => node.id);
  const orphanProcedures = procedureNodes
    .filter(
      (node) =>
        node.id !== "MAIN" &&
        node.kind === "function" &&
        !node.isSignalHandler &&
        !reachable.has(node.id)
    )
    .map((node) => node.id);

  const undefinedLabels = nodes
    .filter((node) => node.kind === "reference" && !definedProcedureIds.has(node.id))
    .map((node) => {
      const refs = referenceSites.get(node.id) || [];
      return {
        id: node.id,
        line: node.line,
        callers: Array.from(new Set(refs.map((ref) => ref.scope))).sort(),
        referenceTypes: Array.from(new Set(refs.map((ref) => ref.type))).sort()
      };
    })
    .sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));

  const suspiciousCallTargets = undefinedLabels.map((item) => ({
    ...item,
    message: `No matching label definition was found for ${item.id}.`
  }));

  const recursiveCycles = computeRecursiveCycles(procedureNodes, outgoing);
  const cycleMembers = new Set(recursiveCycles.flatMap((cycle) => cycle.members));
  const procedureDetails = procedureNodes
    .map((node) => buildProcedureAnalysis(node.id, scopeStatements.get(node.id) || []))
    .sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
  const procedureDetailById = new Map(procedureDetails.map((detail) => [detail.id, detail]));

  const metrics = procedureNodes
    .map((node) => {
      const detail = procedureDetailById.get(node.id) || buildProcedureAnalysis(node.id, []);
      const statementCount = detail.statementCount;
      const branchCount = detail.branchCount;
      const { returnCount, exitCount } = detail;
      const fanOut = new Set((outgoing.get(node.id) || []).map((edge) => edge.to)).size;
      const fanIn = new Set((incoming.get(node.id) || []).map((edge) => edge.from)).size;
      return {
        id: node.id,
        line: node.line,
        fanIn,
        fanOut,
        statementCount,
        branchCount,
        returnCount,
        exitCount,
        cyclomaticComplexity: 1 + branchCount
      };
    })
    .sort((a, b) => b.cyclomaticComplexity - a.cyclomaticComplexity || a.id.localeCompare(b.id));

  const metricById = new Map(metrics.map((metric) => [metric.id, metric]));
  const cleanupBypassRisks = [];
  for (const [scope, sites] of scopeExitStatements.entries()) {
    const detail = procedureDetailById.get(scope);
    const statements = detail?.statements || [];
    for (const site of sites) {
      const siteIndex = statements.findIndex((statement) => statement.line === site.line && statement.text === site.statement);
      const laterCleanup = siteIndex >= 0
        ? statements.slice(siteIndex + 1).find((statement) => statement.isCleanupLike)
        : null;
      if (laterCleanup) {
        cleanupBypassRisks.push({
          scope,
          line: site.line,
          statement: site.statement,
          bypassedLine: laterCleanup.line,
          message: `EXIT bypasses later cleanup-like statement at line ${laterCleanup.line}.`
        });
        continue;
      }

      const outgoingTargets = new Set((outgoing.get(scope) || []).map((edge) => edge.to));
      const hasCleanupCall = Array.from(outgoingTargets).some((target) => isCleanupLikeText(target));
      if (scope !== "MAIN" && !hasCleanupCall) {
        cleanupBypassRisks.push({
          scope,
          line: site.line,
          statement: site.statement,
          bypassedLine: null,
          message: "EXIT appears in a procedure with no obvious cleanup path."
        });
      }
    }
  }

  const possibleInfiniteLoops = [
    ...recursiveCycles
      .filter((cycle) => cycle.members.some((member) => {
        const m = metricById.get(member);
        return ((m?.returnCount || 0) + (m?.exitCount || 0)) === 0;
      }))
      .map((cycle) => ({
        id: cycle.id,
        members: cycle.members,
        lines: cycle.lines,
        message: "Recursive cycle has no explicit RETURN or EXIT in at least one member."
      })),
    ...procedureDetails
      .filter((detail) => detail.hasDoForever && !detail.hasLoopEscape)
      .map((detail) => ({
        id: `loop:${detail.id}`,
        members: [detail.id],
        lines: [detail.line],
        message: "Procedure contains DO FOREVER without a visible LEAVE, RETURN, or EXIT."
      }))
  ];
  const deadCodeStatements = procedureDetails.flatMap((detail) =>
    detail.deadCode.map((item) => ({
      scope: detail.id,
      line: item.line,
      statement: item.text,
      afterLine: item.afterLine
    }))
  );
  const lineLengthWarnings = collectLineLengthWarnings(sourceLines, 80);

  const sectionInfo = buildSectionGroups(procedureNodes);
  const groups = {
    file: [{ id: "file:current", label: "Current File", nodeIds: nodes.map((node) => node.id) }],
    kind: buildKindGroups(nodes),
    section: sectionInfo.groups,
    cycle: recursiveCycles.map((cycle) => ({
      id: cycle.id,
      label: cycle.label,
      nodeIds: [...cycle.members]
    }))
  };

  const groupMap = {
    section: new Map(sectionInfo.assignments),
    cycle: new Map(recursiveCycles.flatMap((cycle) => cycle.members.map((member) => [member, cycle.id])))
  };
  const groupLabels = new Map([
    ...sectionInfo.groups.map((group) => [group.id, group.label]),
    ...recursiveCycles.map((cycle) => [cycle.id, cycle.label])
  ]);

  return {
    roots: ["MAIN"],
    unreachableProcedures,
    orphanProcedures,
    undefinedLabels,
    suspiciousCallTargets,
    recursiveCycles,
    possibleInfiniteLoops,
    deadCodeStatements,
    lineLengthWarnings,
    cleanupBypassRisks,
    metrics,
    procedures: procedureDetails,
    groups,
    groupMap,
    groupLabels,
    cycleMembers: [...cycleMembers]
  };
}

function buildNodeFlags(nodeId, analysis) {
  const flags = [];
  if (analysis.unreachableProcedures.includes(nodeId)) {
    flags.push("unreachable");
  }
  if (analysis.orphanProcedures.includes(nodeId)) {
    flags.push("orphan");
  }
  if (analysis.cycleMembers.includes(nodeId)) {
    flags.push("recursive");
  }
  if (analysis.undefinedLabels.some((item) => item.id === nodeId)) {
    flags.push("undefined");
  }
  if ((analysis.procedures || []).some((item) => item.id === nodeId && item.deadCode.length > 0)) {
    flags.push("dead-code");
  }
  return flags;
}

function recordScopeStatement(scopeStatements, scope, statement, line) {
  if (!scopeStatements.has(scope)) {
    scopeStatements.set(scope, []);
  }
  scopeStatements.get(scope).push(buildStatementRecord(statement, line));
}

function maybeRecordExitRisk(scopeExitStatements, scope, statement, line) {
  const upper = collapse(maskQuotedText(String(statement || "").toUpperCase()));
  if (!/\bEXIT\b/.test(upper)) {
    return;
  }
  if (!scopeExitStatements.has(scope)) {
    scopeExitStatements.set(scope, []);
  }
  scopeExitStatements.get(scope).push({ statement, line });
}

function recordReference(referenceSites, target, scope, line, type) {
  if (!referenceSites.has(target)) {
    referenceSites.set(target, []);
  }
  referenceSites.get(target).push({ scope, line, type });
}

function walkReachable(start, outgoing) {
  const visited = new Set();
  if (!outgoing.has(start)) {
    return visited;
  }
  const queue = [start];
  visited.add(start);
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    for (const edge of outgoing.get(current) || []) {
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return visited;
}

function countBranchStatements(statements) {
  let count = 0;
  for (const item of statements) {
    const upper = item.analysisUpper;
    count += countMatches(upper, /\bIF\b/g);
    count += countMatches(upper, /\bWHEN\b/g);
    count += countMatches(upper, /\bOTHERWISE\b/g);
    count += countMatches(upper, /\bSELECT\b/g);
    count += countMatches(upper, /\bDO\b\s+(?:WHILE|UNTIL|FOREVER)\b/g);
    count += countMatches(upper, /\bSIGNAL\b\s+ON\b/g);
  }
  return count;
}

function countExitStatements(statements) {
  let returns = 0;
  let exits = 0;
  for (const item of statements) {
    returns += countMatches(item.analysisUpper, /\bRETURN\b/g);
    exits += countMatches(item.analysisUpper, /\bEXIT\b/g);
  }
  return { returnCount: returns, exitCount: exits };
}

function countMatches(text, pattern) {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function collectLineLengthWarnings(lines, maxColumns) {
  const warnings = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = String(lines[i] || "");
    if (!line.trim()) {
      continue;
    }
    if (line.length > maxColumns) {
      warnings.push({
        line: i + 1,
        length: line.length,
        maxColumns,
        preview: collapse(line).slice(0, 96)
      });
    }
  }
  return warnings;
}

function buildStatementRecord(statement, line) {
  const text = collapse(statement);
  const upper = text.toUpperCase();
  const analysisUpper = collapse(maskQuotedText(upper));
  const kind = classifyStatementKind(analysisUpper);
  return {
    line,
    text,
    upper,
    analysisUpper,
    kind,
    isConditional: kind === "conditional",
    opensGuardedNextStatement: opensGuardedNextStatement(analysisUpper),
    isLoop: kind === "loop",
    isTerminal: isUnconditionalTerminal(analysisUpper),
    isLoopEscape: /\b(?:LEAVE|ITERATE)\b/.test(analysisUpper),
    isCleanupLike: isCleanupLikeText(analysisUpper),
    opensDoBlock: opensDoBlock(analysisUpper),
    closesBlock: closesBlock(analysisUpper)
  };
}

function classifyStatementKind(upper) {
  if (/^IF\b/.test(upper)) {
    return "conditional";
  }
  if (/^(SELECT|WHEN|OTHERWISE)\b/.test(upper)) {
    return "branch";
  }
  if (/^DO\b(?:\s+(?:WHILE|UNTIL|FOREVER))?/.test(upper)) {
    return "loop";
  }
  if (/^RETURN\b/.test(upper)) {
    return "return";
  }
  if (/^EXIT\b/.test(upper)) {
    return "exit";
  }
  if (/^SIGNAL\b(?!\s+ON\b)/.test(upper)) {
    return "signal";
  }
  if (/^CALL\b/.test(upper)) {
    return "call";
  }
  return "statement";
}

function isUnconditionalTerminal(upper) {
  return /^RETURN\b/.test(upper) || /^EXIT\b/.test(upper) || /^SIGNAL\b(?!\s+ON\b)/.test(upper);
}

function opensGuardedNextStatement(upper) {
  if (!/^(IF|WHEN)\b/.test(upper)) {
    return false;
  }
  if (!/\bTHEN\b/.test(upper)) {
    return false;
  }
  if (/\bTHEN\s+DO\b/.test(upper)) {
    return false;
  }
  return /\bTHEN\s*$/.test(upper);
}

function opensDoBlock(upper) {
  if (/^END\b/.test(upper)) {
    return false;
  }
  return /\bDO\b/.test(upper);
}

function closesBlock(upper) {
  return /^END\b/.test(upper);
}

function isCleanupLikeText(text) {
  return /(CLEAN|CLOSE|FINAL|FREE|RELEASE|RESET|RESTORE|ROLLBACK|TEARDOWN|UNLOCK)/.test(
    String(text || "").toUpperCase()
  );
}

function buildProcedureAnalysis(id, statements) {
  const normalizedStatements = statements.map((statement) =>
    statement.upper ? statement : buildStatementRecord(statement.statement || statement.text || "", statement.line)
  );
  const cfgNodes = normalizedStatements.map((statement, index) => ({
    id: `${id}:${index + 1}`,
    line: statement.line,
    text: statement.text,
    kind: statement.kind
  }));
  const cfgEdges = [];
  const deadCode = [];
  let reachable = true;
  let terminalLine = null;
  let guardedByPreviousConditional = false;
  let blockDepth = 0;

  for (let i = 0; i < normalizedStatements.length; i += 1) {
    const previous = normalizedStatements[i - 1] || null;
    const current = normalizedStatements[i];
    const next = normalizedStatements[i + 1] || null;
    const depthBeforeStatement = blockDepth;
    current.reachable = reachable;
    if (!reachable) {
      const isImmediateReturnAfterExit =
        current.kind === "return" &&
        previous &&
        previous.kind === "exit" &&
        current.line === previous.line + 1;
      if (!isImmediateReturnAfterExit) {
        deadCode.push({ line: current.line, text: current.text, afterLine: terminalLine });
      }
      if (current.closesBlock) {
        blockDepth = Math.max(0, blockDepth - 1);
      }
      if (current.opensDoBlock) {
        blockDepth += 1;
      }
      continue;
    }

    const isConditionallyExecutedTerminal = current.isTerminal && guardedByPreviousConditional;
    const isTerminalInsideBlock = current.isTerminal && depthBeforeStatement > 0;
    const isExitFollowedByImmediateReturn =
      current.kind === "exit" && next && next.kind === "return" && next.line === current.line + 1;

    if (
      current.isTerminal &&
      !isConditionallyExecutedTerminal &&
      !isTerminalInsideBlock &&
      !isExitFollowedByImmediateReturn
    ) {
      terminalLine = current.line;
      cfgEdges.push({
        from: `${id}:${i + 1}`,
        to: null,
        type: "terminal",
        line: current.line
      });
      reachable = false;
      continue;
    }

    if (i + 1 < normalizedStatements.length) {
      cfgEdges.push({
        from: `${id}:${i + 1}`,
        to: `${id}:${i + 2}`,
        type: current.isConditional ? "branch-next" : "next",
        line: current.line
      });
    }

    guardedByPreviousConditional = Boolean(current.opensGuardedNextStatement);
    if (isConditionallyExecutedTerminal) {
      guardedByPreviousConditional = false;
    }
    if (current.closesBlock) {
      blockDepth = Math.max(0, blockDepth - 1);
    }
    if (current.opensDoBlock) {
      blockDepth += 1;
    }
  }

  return {
    id,
    line: normalizedStatements[0]?.line || 1,
    statementCount: normalizedStatements.length,
    branchCount: countBranchStatements(normalizedStatements),
    ...countExitStatements(normalizedStatements),
    hasDoForever: normalizedStatements.some((statement) => /\bDO\s+FOREVER\b/.test(statement.analysisUpper)),
    hasLoopEscape: normalizedStatements.some(
      (statement) => statement.isLoopEscape || statement.isTerminal
    ),
    statements: normalizedStatements,
    cfg: {
      nodes: cfgNodes,
      edges: cfgEdges
    },
    deadCode
  };
}

function computeRecursiveCycles(nodes, outgoing) {
  const ids = nodes.map((node) => node.id);
  const idSet = new Set(ids);
  const indexById = new Map();
  const lowById = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let index = 0;

  function strongConnect(id) {
    indexById.set(id, index);
    lowById.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);

    for (const edge of outgoing.get(id) || []) {
      if (!idSet.has(edge.to)) {
        continue;
      }
      if (!indexById.has(edge.to)) {
        strongConnect(edge.to);
        lowById.set(id, Math.min(lowById.get(id), lowById.get(edge.to)));
      } else if (onStack.has(edge.to)) {
        lowById.set(id, Math.min(lowById.get(id), indexById.get(edge.to)));
      }
    }

    if (lowById.get(id) === indexById.get(id)) {
      const component = [];
      while (stack.length) {
        const popped = stack.pop();
        onStack.delete(popped);
        component.push(popped);
        if (popped === id) {
          break;
        }
      }
      components.push(component.sort());
    }
  }

  for (const id of ids) {
    if (!indexById.has(id)) {
      strongConnect(id);
    }
  }

  return components
    .filter((component) => {
      if (component.length > 1) {
        return true;
      }
      const only = component[0];
      return (outgoing.get(only) || []).some((edge) => edge.to === only);
    })
    .map((component, idx) => ({
      id: `cycle:${idx + 1}`,
      label: component.length === 1 ? `Self recursion: ${component[0]}` : `Recursive cycle ${idx + 1}`,
      members: component,
      lines: component.map((member) => nodes.find((node) => node.id === member)?.line || 1).sort((a, b) => a - b)
    }));
}

function buildSectionGroups(nodes) {
  const prefixCounts = new Map();
  for (const node of nodes) {
    const prefix = deriveSectionPrefix(node.id);
    if (!prefix) {
      continue;
    }
    prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
  }

  const assignments = [];
  const groupsById = new Map();
  for (const node of nodes) {
    const prefix = deriveSectionPrefix(node.id);
    const sectionId =
      node.id === "MAIN"
        ? "section:entry"
        : prefix && (prefixCounts.get(prefix) || 0) > 1
          ? `section:${prefix}`
          : "section:core";
    const label =
      sectionId === "section:entry"
        ? "Entry"
        : sectionId === "section:core"
          ? "Core Procedures"
          : prefix;
    assignments.push([node.id, sectionId]);
    if (!groupsById.has(sectionId)) {
      groupsById.set(sectionId, { id: sectionId, label, nodeIds: [] });
    }
    groupsById.get(sectionId).nodeIds.push(node.id);
  }

  return {
    assignments,
    groups: Array.from(groupsById.values()).sort((a, b) => a.label.localeCompare(b.label))
  };
}

function deriveSectionPrefix(id) {
  if (!id || id === "MAIN") {
    return "";
  }
  const token = String(id).split(/[_.]/)[0];
  return token && token.length >= 3 ? token : "";
}

function buildKindGroups(nodes) {
  const buckets = new Map();
  for (const node of nodes) {
    const kind = node.kind || "unknown";
    if (!buckets.has(kind)) {
      buckets.set(kind, { id: `kind:${kind}`, label: kind.replace(/-/g, " "), nodeIds: [] });
    }
    buckets.get(kind).nodeIds.push(node.id);
  }
  return Array.from(buckets.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function extractAddressLinkmvsTargets(segment) {
  const targets = [];
  const pattern = /\bADDRESS\s+LINKMVS\s+(['"])([^'"]+)\1/gi;
  let match;
  while ((match = pattern.exec(segment)) !== null) {
    const target = String(match[2] || "").trim();
    if (target) {
      targets.push(target);
    }
  }
  return targets;
}

function isPotentialTsoCommandStart(segment) {
  return /^\s*"/.test(String(segment || ""));
}

function hasBalancedDoubleQuotes(text) {
  let count = 0;
  for (const ch of String(text || "")) {
    if (ch === '"') {
      count += 1;
    }
  }
  return count >= 2 && count % 2 === 0;
}

function addTsoCommandNode(nodes, edges, edgeKeys, scope, text, lineNo) {
  const label = summarizeTsoCommand(text);
  if (!label) {
    return;
  }
  const normalizedTarget = normalizeExternalTarget(label);
  const nodeId = `TSO:${normalizedTarget}`;
  upsertNode(nodes, nodeId, label, lineNo, "tso-command");
  addEdge(edges, edgeKeys, scope, nodeId, "tso-call", lineNo);
}

function summarizeTsoCommand(text) {
  const normalized = collapse(String(text || ""));
  if (!normalized) {
    return "";
  }
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

function normalizeExternalTarget(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
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

  if (line < existing.line && existing.kind !== "function" && existing.kind !== "entry") {
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
    out.push(`  "${escapeDot(node.id)}" [label="${escapeDot(node.label)}"];`);
  }

  for (const edge of graph.edges) {
    out.push(
      `  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [label="${escapeDot(edge.type)}"];`
    );
  }

  out.push("}");
  return out.join("\n");
}

function escapeDot(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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
