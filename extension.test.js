const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  buildWebviewCsp,
  createGraphWebviewOptions,
  nodeCategoryForKind,
  normalizeGraphWebviewMessage,
  renderGraphHtml,
  sanitizeCss
} = require('./extension');

Module._load = originalLoad;

test('maps external program nodes to the external filter category', () => {
  assert.equal(nodeCategoryForKind('external-program'), 'external');
});

test('maps tso and dynamic nodes to their filter categories', () => {
  assert.equal(nodeCategoryForKind('tso-command'), 'tso');
  assert.equal(nodeCategoryForKind('dynamic-call'), 'dynamic');
  assert.equal(nodeCategoryForKind('dynamic-jump'), 'dynamic');
});

test('leaves regular procedure nodes unfiltered by category', () => {
  assert.equal(nodeCategoryForKind('function'), '');
  assert.equal(nodeCategoryForKind('entry'), '');
});

test('creates a locked-down webview configuration', () => {
  assert.deepEqual(createGraphWebviewOptions(), {
    enableScripts: true,
    localResourceRoots: []
  });
});

test('builds a restrictive webview CSP with a script nonce', () => {
  const csp = buildWebviewCsp('abc123');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /img-src data: blob:/);
  assert.match(csp, /script-src 'nonce-abc123'/);
});

test('normalizes allowed webview messages and rejects invalid ones', () => {
  assert.deepEqual(normalizeGraphWebviewMessage({ type: 'exportDot' }), { type: 'exportDot' });
  assert.deepEqual(normalizeGraphWebviewMessage({ type: 'revealLine', line: -4 }), {
    type: 'revealLine',
    line: 1,
    uri: ''
  });
  assert.deepEqual(
    normalizeGraphWebviewMessage({ type: 'revealLine', line: 5, uri: 'file:///tmp/a.rex' }),
    { type: 'revealLine', line: 5, uri: 'file:///tmp/a.rex' }
  );
  assert.deepEqual(
    normalizeGraphWebviewMessage({
      type: 'persistUiState',
      state: {
        viewMode: 'detailed',
        snapToGrid: true,
        pinnedNodeIds: ['MAIN'],
        nodePositions: { MAIN: { x: 96, y: 144 } }
      }
    }),
    {
      type: 'persistUiState',
      state: {
        viewMode: 'detailed',
        snapToGrid: true,
        pinnedNodeIds: ['MAIN'],
        nodePositions: { MAIN: { x: 96, y: 144 } }
      }
    }
  );
  assert.deepEqual(normalizeGraphWebviewMessage({ type: 'exportPngError', error: 'bad png' }), {
    type: 'exportPngError',
    error: 'bad png'
  });
  assert.equal(normalizeGraphWebviewMessage({ type: 'deleteEverything' }), null);
  assert.equal(
    normalizeGraphWebviewMessage({ type: 'exportPng', png: 'javascript:alert(1)' }),
    null
  );
});

test('sanitizes custom css so it cannot break out of the style tag', () => {
  assert.equal(sanitizeCss('</style><script>alert(1)</script>'), '<\\/style><script>alert(1)</script>');
});

test('strips risky css features from custom stylesheets', () => {
  const css = sanitizeCss(`
    @import url("https://example.com/a.css");
    @font-face { font-family: bad; src: url("https://example.com/font.woff2"); }
    .graph { background-image: url("https://example.com/bg.png"); }
    .node { width: expression(alert(1)); behavior: url(test.htc); -moz-binding: url(xbl.xml#xbl); }
  `);

  assert.doesNotMatch(css, /@import/i);
  assert.doesNotMatch(css, /@font-face/i);
  assert.doesNotMatch(css, /https:\/\/example\.com/i);
  assert.doesNotMatch(css, /expression\s*\(/i);
  assert.doesNotMatch(css, /\bbehavior\s*:/i);
  assert.doesNotMatch(css, /\b-moz-binding\s*:/i);
  assert.match(css, /background-image:\s*url\(\)/i);
});

test('renders webview html with nonce-based script and sanitized custom css', () => {
  const html = renderGraphHtml(
    { nodes: [], edges: [], analysis: { metrics: [] } },
    'demo.rex',
    '@import url("https://example.com/a.css"); .node{background:url("x")} </style>',
    'graph',
    'nonce123'
  );

  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script nonce="nonce123"/);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /url\("https:\/\/example\.com\/a\.css"\)/i);
  assert.match(html, /background:url\(\)/i);
  assert.match(html, /<\\\/style>/);
});

test('renders graph mode fit logic with movable nodes, pointer interactions, and layout controls', () => {
  const html = renderGraphHtml(
    { nodes: [], edges: [], analysis: { metrics: [] } },
    'demo.rex',
    '',
    'graph',
    'nonce123'
  );

  assert.match(html, /class="app"/);
  assert.match(html, /class: 'context-menu'/);
  assert.match(html, /openContextMenu\(event\.clientX, event\.clientY\)/);
  assert.match(html, /Export JSON/);
  assert.match(html, /Export DOT/);
  assert.match(html, /Export Excalidraw/);
  assert.match(html, /Export SVG/);
  assert.match(html, /Export PNG/);
  assert.match(html, /vscode\.postMessage\(\{ type: 'exportGraphJson' \}\)/);
  assert.match(html, /vscode\.postMessage\(\{ type: 'exportSvg', svg: buildExportSvgString\(\) \}\)/);
  assert.match(html, /function exportPng\(\) \{/);
  assert.match(html, /msg\.type === 'triggerExportSvg'/);
  assert.match(html, /msg\.type === 'triggerExportPng'/);
  assert.match(html, /function computeLayout\(\) \{/);
  assert.match(html, /const longestFunctionName = Math\.max\(0, \.\.\.REX\.FUNCTIONS\.map/);
  assert.match(html, /const NODE_W = Math\.max\(220, longestFunctionName \* 8 \+ 108\);/);
  assert.match(html, /width: NODE_W \+ 'px'/);
  assert.match(html, /state\.layout === 'layered'/);
  assert.match(html, /state\.layout === 'radial'/);
  assert.match(html, /function edgePath\(from, to\) \{/);
  assert.match(html, /const horizontal = Math\.abs\(dx\) >= Math\.abs\(dy\);/);
  assert.match(html, /Math\.hypot\(dx, dy\) \* \.34/);
  assert.match(html, /return 'M' \+ sx \+ ',' \+ sy \+ ' C'/);
  assert.match(html, /function fitGraph\(\) \{/);
  assert.match(html, /class: 'graph-layer'/);
  assert.match(html, /transform-origin: 0 0;/);
  assert.match(html, /graphLayer\.style\.transform = t;/);
  assert.doesNotMatch(html, /edgesSvg\.style\.transform = t;/);
  assert.match(html, /function renderMinimap\(\) \{/);
  assert.match(html, /function renderInspector\(root\) \{/);
  assert.match(html, /window\.addEventListener\('mousemove'/);
  assert.match(html, /window\.addEventListener\('keydown'/);
  assert.match(html, /min-width: 0;/);
});

test('adapts graph data into the new module sidebar and inspector view', () => {
  const html = renderGraphHtml(
    {
      nodes: [{ id: 'MAIN', label: 'MAIN', line: 1, kind: 'entry', flags: [], fileLabel: 'demo.rex' }],
      edges: [],
      analysis: { metrics: [] }
    },
    'demo.rex',
    '',
    'graph',
    'nonce123',
    {
      pinnedNodeIds: ['MAIN'],
      nodePositions: { MAIN: { x: 320, y: 180 } }
    }
  );

  assert.match(html, /"MODULES":\[\{"id":"demo_rex","label":"demo\.rex"/);
  assert.match(html, /"FUNCTIONS":\[\{"id":"MAIN","name":"MAIN","module":"demo_rex","line":1/);
  assert.match(html, /selectedId: REX\.FN_BY_ID\.MAIN \? 'MAIN'/);
  assert.match(html, /relList\('Called by', callers\)/);
  assert.match(html, /relList\('Calls', fn\.calls\)/);
});
