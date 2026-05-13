const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRexxControlFlow, toDot, toExcalidraw } = require('./parser');

function hasEdge(graph, from, to, type) {
  return graph.edges.some((e) => e.from === from && e.to === to && e.type === type);
}

test('captures calls from MAIN and labels as function-level call graph', () => {
  const src = `CALL INIT
CALL RUN
INIT:
  CALL UTIL
  RETURN
RUN:
  CALL UTIL
  CALL REPORT
  RETURN
UTIL:
  RETURN
REPORT:
  RETURN`;

  const g = parseRexxControlFlow(src);

  assert.ok(g.nodes.some((n) => n.id === 'MAIN'));
  assert.ok(g.nodes.some((n) => n.id === 'INIT'));
  assert.ok(g.nodes.some((n) => n.id === 'RUN'));
  assert.ok(g.nodes.some((n) => n.id === 'UTIL'));
  assert.ok(g.nodes.some((n) => n.id === 'REPORT'));

  assert.ok(hasEdge(g, 'MAIN', 'INIT', 'calls'));
  assert.ok(hasEdge(g, 'MAIN', 'RUN', 'calls'));
  assert.ok(hasEdge(g, 'INIT', 'UTIL', 'calls'));
  assert.ok(hasEdge(g, 'RUN', 'UTIL', 'calls'));
  assert.ok(hasEdge(g, 'RUN', 'REPORT', 'calls'));
});

test('deduplicates repeated calls and handles semicolon-separated statements', () => {
  const src = `CALL A; CALL A; SAY 'x;y'; CALL B
A: CALL B; CALL B
B: RETURN`;

  const g = parseRexxControlFlow(src);

  assert.equal(g.edges.filter((e) => e.from === 'MAIN' && e.to === 'A').length, 1);
  assert.equal(g.edges.filter((e) => e.from === 'MAIN' && e.to === 'B').length, 1);
  assert.equal(g.edges.filter((e) => e.from === 'A' && e.to === 'B').length, 1);
});

test('tracks dynamic calls as a single dynamic target', () => {
  const src = `CALL VALUE expr
worker: CALL (name)
`;

  const g = parseRexxControlFlow(src);

  assert.ok(g.nodes.some((n) => n.id === 'DYNAMIC_CALL'));
  assert.ok(hasEdge(g, 'MAIN', 'DYNAMIC_CALL', 'calls-dynamic'));
  assert.ok(hasEdge(g, 'WORKER', 'DYNAMIC_CALL', 'calls-dynamic'));
});

test('finds calls nested in conditionals', () => {
  const src = `Msg: procedure expose logEnabled\n  if logEnabled then call Log text\n  return\nLog: procedure\n  return\n`;
  const g = parseRexxControlFlow(src);
  assert.ok(hasEdge(g, 'MSG', 'LOG', 'calls'));
});

test('finds direct function-style calls like Prompt(...) within procedures', () => {
  const src = `Prompt: procedure\n  return ''\naction_loadrecord: procedure\n  mode = Prompt("Input mode (DD/USS)", inputMode)\n  return\n`;
  const g = parseRexxControlFlow(src);
  assert.ok(hasEdge(g, 'ACTION_LOADRECORD', 'PROMPT', 'calls'));
});

test('captures ADDRESS LINKMVS quoted targets as external program calls', () => {
  const src = `Main:
  address linkmvs "TPXUSNSF"
  ADDRESS LINKMVS 'IEFBR14'
  return`;
  const g = parseRexxControlFlow(src);
  const ext1 = g.nodes.find((n) => n.id === 'LINKMVS:TPXUSNSF');
  const ext2 = g.nodes.find((n) => n.id === 'LINKMVS:IEFBR14');
  assert.ok(ext1);
  assert.ok(ext2);
  assert.equal(ext1.kind, 'external-program');
  assert.equal(ext1.label, 'TPXUSNSF');
  assert.ok(hasEdge(g, 'MAIN', 'LINKMVS:TPXUSNSF', 'external-call'));
  assert.ok(hasEdge(g, 'MAIN', 'LINKMVS:IEFBR14', 'external-call'));
});

test('captures quoted TSO command statements as tso command calls', () => {
  const src = `Main:
  "EXECIO * DISKR" cfgDD "(STEM cfg. FINIS"
  return`;
  const g = parseRexxControlFlow(src);
  const tso = g.nodes.find((n) => n.id.startsWith('TSO:'));

  assert.ok(tso);
  assert.equal(tso.kind, 'tso-command');
  assert.ok(hasEdge(g, 'MAIN', tso.id, 'tso-call'));
});

test('captures TSO command text when paired double quotes span multiple lines', () => {
  const src = `Main:
  "ALLOC FI(INPUT) DA('SYS1.PARMLIB')
  SHR REUSE"
  return`;
  const g = parseRexxControlFlow(src);
  const tso = g.nodes.find((n) => n.id.startsWith('TSO:'));

  assert.ok(tso);
  assert.ok(tso.label.includes('ALLOC FI(INPUT)'));
  assert.ok(hasEdge(g, 'MAIN', tso.id, 'tso-call'));
});

test('resolves function-style calls to labels defined later in file', () => {
  const src = `x = Helper("abc")\nreturn\nHelper: procedure\n  return\n`;
  const g = parseRexxControlFlow(src);
  assert.ok(hasEdge(g, 'MAIN', 'HELPER', 'calls'));
});

test('marks SIGNAL ON NAME handlers as signal functions', () => {
  const src = `signal on syntax name TrapSyntax\nTrapSyntax: procedure\n  return`;
  const g = parseRexxControlFlow(src);
  const handler = g.nodes.find((n) => n.id === 'TRAPSYNTAX');
  assert.ok(handler);
  assert.equal(handler.isSignalHandler, true);
  assert.ok(hasEdge(g, 'MAIN', 'TRAPSYNTAX', 'signal-on'));
  assert.equal(handler.line, 2);
});

test('reports undefined labels and unreachable procedures', () => {
  const src = `CALL START
CALL MISSING_LABEL
START: CALL WORKER
  RETURN
WORKER: RETURN
UNUSED: RETURN`;
  const g = parseRexxControlFlow(src);

  assert.deepEqual(g.analysis.undefinedLabels.map((item) => item.id), ['MISSING_LABEL']);
  assert.ok(g.analysis.unreachableProcedures.includes('UNUSED'));
  assert.ok(g.analysis.orphanProcedures.includes('UNUSED'));
});

test('reports lines that exceed the 80-column limit', () => {
  const src = `MAIN:
  SAY "123456789012345678901234567890123456789012345678901234567890123456789012345678901"
  RETURN`;
  const g = parseRexxControlFlow(src);

  assert.equal(g.analysis.lineLengthWarnings.length, 1);
  assert.equal(g.analysis.lineLengthWarnings[0].line, 2);
  assert.ok(g.analysis.lineLengthWarnings[0].length > 80);
});

test('surfaces recursive cycles and complexity metrics', () => {
  const src = `CALL A
A: IF ready THEN CALL B
  RETURN
B: CALL A
  RETURN`;
  const g = parseRexxControlFlow(src);

  assert.equal(g.analysis.recursiveCycles.length, 1);
  assert.deepEqual(g.analysis.recursiveCycles[0].members, ['A', 'B']);

  const metricA = g.analysis.metrics.find((item) => item.id === 'A');
  assert.ok(metricA);
  assert.equal(metricA.branchCount, 1);
  assert.equal(metricA.cyclomaticComplexity, 2);
});

test('flags exit statements that may bypass cleanup heuristically', () => {
  const src = `MAIN: CALL WORK
  RETURN
WORK:
  IF bad THEN EXIT
  RETURN`;
  const g = parseRexxControlFlow(src);

  assert.equal(g.analysis.cleanupBypassRisks.length, 1);
  assert.equal(g.analysis.cleanupBypassRisks[0].scope, 'WORK');
});

test('detects dead code after unconditional return within a procedure', () => {
  const src = `MAIN:
  CALL INIT
  RETURN
  CALL NEVER
INIT: RETURN
NEVER: RETURN`;
  const g = parseRexxControlFlow(src);

  assert.equal(g.analysis.deadCodeStatements.length, 1);
  assert.equal(g.analysis.deadCodeStatements[0].scope, 'MAIN');
  assert.equal(g.analysis.deadCodeStatements[0].line, 4);
  assert.ok(g.nodes.find((node) => node.id === 'MAIN').flags.includes('dead-code'));
});

test('does not mark code unreachable when return is guarded by IF THEN on prior line', () => {
  const src = `MAIN:
  IF ready THEN
    RETURN
  CALL NEXT
NEXT: RETURN`;
  const g = parseRexxControlFlow(src);

  assert.equal(g.analysis.deadCodeStatements.length, 0);
});

test('does not mark code unreachable when return is inside IF THEN DO block', () => {
  const src = `LOADCONFIG:
  if \\IsDDAllocated(cfgDD) then do
    call Msg "Config DD not allocated; using defaults."
    return
  end
  call Msg "Loading config from DD:" cfgDD
  return`;
  const g = parseRexxControlFlow(src);

  assert.equal(g.analysis.deadCodeStatements.length, 0);
});

test('does not mark dead code when exit is immediately followed by return', () => {
  const src = `MAIN:
  if bad then exit
  return
  call NEXT
NEXT: return`;
  const g = parseRexxControlFlow(src);

  assert.equal(g.analysis.deadCodeStatements.length, 1);
  assert.equal(g.analysis.deadCodeStatements[0].line, 4);
});

test('ignores control-flow keywords that only appear inside quoted strings', () => {
  const src = `MENU:
  say "X) Exit"
  say "DO FOREVER"
  say "RETURN to menu"
  pull ans
  return ans`;
  const g = parseRexxControlFlow(src);
  const menu = g.analysis.procedures.find((item) => item.id === 'MENU');

  assert.ok(menu);
  assert.equal(menu.returnCount, 1);
  assert.equal(menu.exitCount, 0);
  assert.equal(menu.hasDoForever, false);
  assert.equal(g.analysis.cleanupBypassRisks.length, 0);
  assert.equal(g.analysis.possibleInfiniteLoops.length, 0);
});

test('flags do forever loops with no visible escape', () => {
  const src = `MAIN:
  DO FOREVER
  CALL SPIN
SPIN: RETURN`;
  const g = parseRexxControlFlow(src);

  assert.ok(g.analysis.possibleInfiniteLoops.some((item) => item.id === 'loop:MAIN'));
});

test('exposes procedure-level statement cfg metadata', () => {
  const src = `MAIN:
  CALL INIT
  RETURN
INIT:
  IF ready THEN CALL WORK
  RETURN
WORK: RETURN`;
  const g = parseRexxControlFlow(src);
  const main = g.analysis.procedures.find((item) => item.id === 'MAIN');

  assert.ok(main);
  assert.equal(main.cfg.nodes.length, 2);
  assert.equal(main.cfg.edges.length, 2);
  assert.equal(main.cfg.edges[1].type, 'terminal');
});

test('renders DOT output with expected graph header', () => {
  const g = parseRexxControlFlow('CALL A\nA: RETURN');
  const dot = toDot(g);
  assert.ok(dot.startsWith('digraph REXXControlFlow {'));
  assert.ok(dot.includes('rankdir=TB;'));
  assert.ok(dot.includes('"MAIN" -> "A"'));
});

test('renders Excalidraw output with bound arrows for all graph edges', () => {
  const g = parseRexxControlFlow('CALL A\nCALL B\nA: CALL B\nB: RETURN');
  const excalidraw = JSON.parse(toExcalidraw(g));

  assert.equal(excalidraw.type, 'excalidraw');
  assert.equal(excalidraw.version, 2);
  assert.ok(Array.isArray(excalidraw.elements));

  const rectangles = excalidraw.elements.filter((el) => el.type === 'rectangle');
  const arrows = excalidraw.elements.filter((el) => el.type === 'arrow');
  const texts = excalidraw.elements.filter((el) => el.type === 'text');
  assert.equal(rectangles.length, g.nodes.length);
  assert.equal(arrows.length, g.edges.length);

  const rectIdToNodeId = new Map();
  for (const text of texts) {
    if (!text.containerId || !text.text) {
      continue;
    }
    rectIdToNodeId.set(text.containerId, String(text.text).toUpperCase());
  }

  for (const edge of g.edges) {
    const match = arrows.find(
      (arrow) => {
        const fromNode = rectIdToNodeId.get(arrow.startBinding?.elementId);
        const toNode = rectIdToNodeId.get(arrow.endBinding?.elementId);
        return fromNode === edge.from && toNode === edge.to;
      }
    );
    assert.ok(match, `missing bound arrow for ${edge.from} -> ${edge.to}`);
  }
});
