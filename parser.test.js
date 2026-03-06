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
