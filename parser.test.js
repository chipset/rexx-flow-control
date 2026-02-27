const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRexxControlFlow, toDot } = require('./parser');

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

test('renders DOT output with expected graph header', () => {
  const g = parseRexxControlFlow('CALL A\nA: RETURN');
  const dot = toDot(g);
  assert.ok(dot.startsWith('digraph REXXControlFlow {'));
  assert.ok(dot.includes('rankdir=LR;'));
  assert.ok(dot.includes('"MAIN" -> "A"'));
});
