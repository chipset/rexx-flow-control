const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

function createUri(fsPath) {
  return {
    fsPath,
    toString() {
      return `file://${fsPath}`;
    }
  };
}

function createDocument({ fileName, text, version = 1, languageId = "rexx" }) {
  const uri = createUri(fileName);
  const lines = String(text).split(/\r?\n/);
  return {
    fileName,
    languageId,
    version,
    uri,
    lineCount: lines.length,
    getText() {
      return text;
    }
  };
}

function loadExtensionWithMocks({ vscodeMock, parserMock }) {
  const extensionPath = require.resolve("./extension");
  delete require.cache[extensionPath];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return vscodeMock;
    }
    if (request === "./parser") {
      return parserMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("./extension");
  } finally {
    Module._load = originalLoad;
  }
}

function createVscodeHarness({ document, documents, config = {}, isTrusted = true, saveUri }) {
  const knownDocuments = [document, ...(documents || [])].filter(Boolean);
  const documentsByUri = new Map(
    knownDocuments.map((entry) => [entry.uri.toString(), entry])
  );
  const workspaceStateStore = new Map();
  const commands = new Map();
  const warnings = [];
  const errors = [];
  const infos = [];
  const clipboardWrites = [];
  const postedMessages = [];
  const panels = [];
  const shownDocuments = [];
  const listeners = {
    change: [],
    save: [],
    config: [],
    open: [],
    close: [],
    selection: []
  };

  let activeEditor = {
    document,
    selection: { active: { line: 0, character: 0 } },
    revealRange(range) {
      this.lastRevealRange = range;
    }
  };

  const disposables = [];
  const makeDisposable = (dispose = () => {}) => {
    const disposable = { dispose };
    disposables.push(disposable);
    return disposable;
  };

  const createWebviewPanel = () => {
    let receiveHandler = null;
    let disposeHandler = null;
    const panel = {
      visible: true,
      title: "",
      disposed: false,
      reveal() {
        this.visible = true;
      },
      onDidDispose(handler) {
        disposeHandler = handler;
        return makeDisposable();
      },
      dispose() {
        this.disposed = true;
        if (disposeHandler) {
          disposeHandler();
        }
      },
      webview: {
        html: "",
        onDidReceiveMessage(handler) {
          receiveHandler = handler;
          return makeDisposable();
        },
        async postMessage(message) {
          postedMessages.push(message);
          return true;
        }
      },
      async receiveMessage(message) {
        if (receiveHandler) {
          await receiveHandler(message);
        }
      }
    };
    panels.push(panel);
    return panel;
  };

  const vscodeMock = {
    Position: class Position {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    Range: class Range {
      constructor(start, end) {
        this.start = start;
        this.end = end;
      }
    },
    Selection: class Selection {
      constructor(anchor, active) {
        this.anchor = anchor;
        this.active = active;
      }
    },
    TextEditorRevealType: {
      InCenter: 0
    },
    ViewColumn: {
      One: 1,
      Beside: 2
    },
    DiagnosticSeverity: {
      Error: 0,
      Warning: 1,
      Information: 2
    },
    Diagnostic: class Diagnostic {
      constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
      }
    },
    CodeLens: class CodeLens {
      constructor(range, command) {
        this.range = range;
        this.command = command;
      }
    },
    Uri: {
      file(fsPath) {
        return createUri(fsPath);
      },
      parse(value) {
        return {
          fsPath: String(value).replace(/^file:\/\//, ""),
          toString() {
            return String(value);
          }
        };
      }
    },
    commands: {
      registerCommand(id, callback) {
        commands.set(id, callback);
        return makeDisposable(() => commands.delete(id));
      }
    },
    languages: {
      createDiagnosticCollection() {
        const entries = new Map();
        return {
          set(uri, diagnostics) {
            entries.set(uri.toString(), diagnostics);
          },
          delete(uri) {
            entries.delete(uri.toString());
          },
          dispose() {
            entries.clear();
          }
        };
      },
      registerCodeLensProvider() {
        return makeDisposable();
      }
    },
    workspace: {
      isTrusted,
      textDocuments: knownDocuments,
      workspaceFolders: [
        {
          name: path.basename(path.dirname(document.fileName)),
          uri: createUri(path.dirname(document.fileName))
        }
      ],
      workspaceState: {
        get(key, fallback) {
          return workspaceStateStore.has(key) ? workspaceStateStore.get(key) : fallback;
        },
        async update(key, value) {
          workspaceStateStore.set(key, value);
        }
      },
      getConfiguration(section) {
        assert.equal(section, "rexxFlow");
        return {
          get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback;
          }
        };
      },
      getWorkspaceFolder() {
        return { uri: { fsPath: path.dirname(document.fileName) } };
      },
      async findFiles() {
        return knownDocuments.map((entry) => entry.uri);
      },
      async openTextDocument(target) {
        const uri = target && target.uri ? target.uri : target;
        if (uri && typeof uri.toString === "function" && documentsByUri.has(uri.toString())) {
          return documentsByUri.get(uri.toString());
        }
        if (uri && typeof uri.fsPath === "string") {
          return {
            fileName: uri.fsPath,
            uri,
            languageId: path.extname(uri.fsPath).slice(1),
            version: 1,
            lineCount: 1,
            getText() {
              return "";
            }
          };
        }
        const error = new Error("Document not found");
        error.code = "ENOENT";
        throw error;
      },
      onDidChangeTextDocument(handler) {
        listeners.change.push(handler);
        return makeDisposable();
      },
      onDidOpenTextDocument(handler) {
        listeners.open.push(handler);
        return makeDisposable();
      },
      onDidCloseTextDocument(handler) {
        listeners.close.push(handler);
        return makeDisposable();
      },
      onDidSaveTextDocument(handler) {
        listeners.save.push(handler);
        return makeDisposable();
      },
      onDidChangeConfiguration(handler) {
        listeners.config.push(handler);
        return makeDisposable();
      }
    },
    env: {
      clipboard: {
        async writeText(value) {
          clipboardWrites.push(value);
        }
      }
    },
    window: {
      get activeTextEditor() {
        return activeEditor;
      },
      set activeTextEditor(editor) {
        activeEditor = editor;
      },
      createWebviewPanel,
      async showWarningMessage(message) {
        warnings.push(message);
      },
      async showErrorMessage(message) {
        errors.push(message);
      },
      async showInformationMessage(message) {
        infos.push(message);
      },
      async showSaveDialog() {
        return saveUri || null;
      },
      async showTextDocument(doc) {
        activeEditor = {
          document: doc,
          selection: { active: { line: 0, character: 0 } },
          revealRange(range) {
            this.lastRevealRange = range;
          }
        };
        shownDocuments.push(doc.fileName);
        return activeEditor;
      },
      onDidChangeTextEditorSelection(handler) {
        listeners.selection.push(handler);
        return makeDisposable();
      }
    }
  };

  return {
    vscodeMock,
    state: {
      workspaceState: {
        get(key, fallback) {
          return workspaceStateStore.has(key) ? workspaceStateStore.get(key) : fallback;
        },
        async update(key, value) {
          workspaceStateStore.set(key, value);
        }
      },
      commands,
      warnings,
      errors,
      infos,
      clipboardWrites,
      panels,
      postedMessages,
      shownDocuments,
      listeners,
      disposables,
      setActiveDocument(doc) {
        activeEditor = {
          document: doc,
          selection: { active: { line: 0, character: 0 } },
          revealRange(range) {
            this.lastRevealRange = range;
          }
        };
      },
      get activeEditor() {
        return activeEditor;
      }
    }
  };
}

function createGraphFixture() {
  return {
    nodes: [{ id: "MAIN", label: "MAIN", kind: "entry", line: 1, flags: [] }],
    edges: [],
    analysis: {
      metrics: [],
      groups: {}
    }
  };
}

test("activate registers commands and reuses the rendered graph cache during JSON export", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rexx-flow-cache-"));
  const sourceDoc = createDocument({
    fileName: path.join(tempDir, "sample.rex"),
    text: "say 'hi'"
  });
  const saveUri = createUri(path.join(tempDir, "sample.json"));
  let parseCalls = 0;
  const parserMock = {
    parseRexxControlFlow() {
      parseCalls += 1;
      return createGraphFixture();
    },
    toDot() {
      return "digraph G {}";
    },
    toExcalidraw() {
      return "{}";
    }
  };
  const { vscodeMock, state } = createVscodeHarness({ document: sourceDoc, saveUri });
  const extension = loadExtensionWithMocks({ vscodeMock, parserMock });

  extension.activate({ subscriptions: [], workspaceState: state.workspaceState });

  assert.ok(state.commands.has("rexxFlow.showControlGraph"));
  assert.ok(state.commands.has("rexxFlow.showWorkspaceControlGraph"));
  assert.ok(state.commands.has("rexxFlow.openTaskDashboard"));
  assert.ok(state.commands.has("rexxFlow.exportGraphJson"));
  assert.ok(state.commands.has("rexxFlow.exportSvg"));
  assert.ok(state.commands.has("rexxFlow.exportPng"));

  await state.commands.get("rexxFlow.showControlGraph")();
  await state.commands.get("rexxFlow.exportGraphJson")();

  assert.equal(parseCalls, 1);
  const exported = await fs.readFile(saveUri.fsPath, "utf8");
  assert.match(exported, /"MAIN"/);
});

test("revealing a selected node lands on its exact source line", async () => {
  const sourceDoc = createDocument({
    fileName: path.join(os.tmpdir(), "rexx-flow-navigation.rex"),
    text: "say 'start'\nfirst:\nsay 'middle'\nsecond:"
  });
  const parserMock = {
    parseRexxControlFlow: createGraphFixture,
    toDot: () => "",
    toExcalidraw: () => "{}"
  };
  const { vscodeMock, state } = createVscodeHarness({ document: sourceDoc });
  const extension = loadExtensionWithMocks({ vscodeMock, parserMock });

  extension.activate({ subscriptions: [], workspaceState: state.workspaceState });
  await state.commands.get("rexxFlow.showControlGraph")();
  await state.panels[0].receiveMessage({ type: "revealLine", line: 4, uri: "" });

  assert.deepEqual(state.shownDocuments, [sourceDoc.fileName]);
  assert.equal(state.activeEditor.selection.active.line, 3);
  assert.equal(state.activeEditor.lastRevealRange.start.line, 3);
});

test("task dashboard command opens a persisted dashboard panel", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rexx-flow-dashboard-"));
  const sourceDoc = createDocument({
    fileName: path.join(tempDir, "sample.rex"),
    text: "say 'hi'"
  });
  const parserMock = {
    parseRexxControlFlow() {
      return createGraphFixture();
    },
    toDot() {
      return "";
    },
    toExcalidraw() {
      return "{}";
    }
  };
  const { vscodeMock, state } = createVscodeHarness({ document: sourceDoc });
  await state.workspaceState.update("rexxFlow.taskDashboard", {
    tasks: [
      {
        id: "task-1",
        title: "Backfill request composer tests",
        notes: "Persist draft state",
        status: "todo",
        priority: "high",
        tags: ["tests"]
      }
    ],
    selectedTaskIds: ["task-1"],
    instruction: "Implement the selected task.",
    query: "",
    statusFilter: "all"
  });
  const extension = loadExtensionWithMocks({ vscodeMock, parserMock });

  extension.activate({ subscriptions: [], workspaceState: state.workspaceState });
  await state.commands.get("rexxFlow.openTaskDashboard")();

  assert.equal(state.panels.length, 1);
  assert.match(state.panels[0].title, /Task Dashboard/);
  assert.match(state.panels[0].webview.html, /Backfill request composer tests/);
  assert.match(state.panels[0].webview.html, /Implement the selected task\./);
});

test("task dashboard messages persist state and copy request text", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rexx-flow-dashboard-msg-"));
  const sourceDoc = createDocument({
    fileName: path.join(tempDir, "sample.rex"),
    text: "say 'hi'"
  });
  const parserMock = {
    parseRexxControlFlow() {
      return createGraphFixture();
    },
    toDot() {
      return "";
    },
    toExcalidraw() {
      return "{}";
    }
  };
  const { vscodeMock, state } = createVscodeHarness({ document: sourceDoc });
  const extension = loadExtensionWithMocks({ vscodeMock, parserMock });

  extension.activate({ subscriptions: [], workspaceState: state.workspaceState });
  await state.commands.get("rexxFlow.openTaskDashboard")();

  await state.panels[0].receiveMessage({
    type: "persistTaskDashboardState",
    state: {
      tasks: [
        {
          id: "task-1",
          title: "Ship dashboard",
          notes: "Need copy flow",
          status: "in-progress",
          priority: "high",
          tags: ["ui", "host"]
        }
      ],
      selectedTaskIds: ["task-1"],
      instruction: "Finish the selected work.",
      query: "ship",
      statusFilter: "in-progress"
    }
  });

  assert.deepEqual(state.workspaceState.get("rexxFlow.taskDashboard"), {
    tasks: [
      {
        id: "task-1",
        title: "Ship dashboard",
        notes: "Need copy flow",
        status: "in-progress",
        priority: "high",
        tags: ["ui", "host"],
        createdAt: "",
        updatedAt: ""
      }
    ],
    selectedTaskIds: ["task-1"],
    instruction: "Finish the selected work.",
    query: "ship",
    statusFilter: "in-progress"
  });

  await state.panels[0].receiveMessage({
    type: "copyTaskRequest",
    text: "Use my selected tasks to finish the dashboard."
  });

  assert.deepEqual(state.clipboardWrites, ["Use my selected tasks to finish the dashboard."]);
  assert.match(state.infos[0], /Task request copied to clipboard/);
});

test("workspace graph command opens a workspace session panel", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rexx-flow-workspace-"));
  const firstDoc = createDocument({
    fileName: path.join(tempDir, "alpha.rex"),
    text: "say 'alpha'"
  });
  const secondDoc = createDocument({
    fileName: path.join(tempDir, "beta.rex"),
    text: "say 'beta'\nnext:"
  });
  let parseCalls = 0;
  const parserMock = {
    parseRexxControlFlow() {
      parseCalls += 1;
      return createGraphFixture();
    },
    toDot() {
      return "";
    },
    toExcalidraw() {
      return "{}";
    }
  };
  const { vscodeMock, state } = createVscodeHarness({
    document: firstDoc,
    documents: [secondDoc]
  });
  const extension = loadExtensionWithMocks({ vscodeMock, parserMock });

  extension.activate({ subscriptions: [], workspaceState: state.workspaceState });
  await state.commands.get("rexxFlow.showWorkspaceControlGraph")();

  assert.equal(state.panels.length, 1);
  assert.match(state.panels[0].title, /Workspace/);
  assert.equal(parseCalls, 2);

  await state.panels[0].receiveMessage({
    type: "revealLine",
    line: 2,
    uri: secondDoc.uri.toString()
  });
  assert.equal(state.activeEditor.document.fileName, secondDoc.fileName);
  assert.equal(state.activeEditor.selection.active.line, 1);
});

test("render failures are surfaced as user-facing errors", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rexx-flow-error-"));
  const sourceDoc = createDocument({
    fileName: path.join(tempDir, "broken.rex"),
    text: "parse me"
  });
  const parserMock = {
    parseRexxControlFlow() {
      throw new Error("parser exploded");
    },
    toDot() {
      return "";
    },
    toExcalidraw() {
      return "{}";
    }
  };
  const { vscodeMock, state } = createVscodeHarness({ document: sourceDoc });
  const extension = loadExtensionWithMocks({ vscodeMock, parserMock });

  extension.activate({ subscriptions: [], workspaceState: state.workspaceState });
  await state.commands.get("rexxFlow.showControlGraph")();

  assert.equal(state.panels.length, 1);
  assert.equal(state.panels[0].disposed, true);
  assert.match(state.errors[0], /Unable to render control flow/);
  assert.match(state.errors[0], /parser exploded/);
});

test("relative custom css is blocked in untrusted workspaces", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rexx-flow-css-"));
  await fs.writeFile(path.join(tempDir, "custom.css"), ".node { color: red; }");
  const sourceDoc = createDocument({
    fileName: path.join(tempDir, "sample.rex"),
    text: "say 'hi'"
  });
  const parserMock = {
    parseRexxControlFlow() {
      return createGraphFixture();
    },
    toDot() {
      return "";
    },
    toExcalidraw() {
      return "{}";
    }
  };
  const { vscodeMock, state } = createVscodeHarness({
    document: sourceDoc,
    config: { customCssFile: "custom.css" },
    isTrusted: false
  });
  const extension = loadExtensionWithMocks({ vscodeMock, parserMock });

  extension.activate({ subscriptions: [], workspaceState: state.workspaceState });
  await state.commands.get("rexxFlow.showControlGraph")();

  assert.match(state.warnings[0], /disabled for untrusted workspaces/);
  assert.doesNotMatch(state.panels[0].webview.html, /id="user-css"/);
});

test("webview message routing surfaces png export failures to the user", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rexx-flow-webview-"));
  const sourceDoc = createDocument({
    fileName: path.join(tempDir, "sample.rex"),
    text: "say 'hi'"
  });
  const parserMock = {
    parseRexxControlFlow() {
      return createGraphFixture();
    },
    toDot() {
      return "";
    },
    toExcalidraw() {
      return "{}";
    }
  };
  const { vscodeMock, state } = createVscodeHarness({ document: sourceDoc });
  const extension = loadExtensionWithMocks({ vscodeMock, parserMock });

  extension.activate({ subscriptions: [], workspaceState: state.workspaceState });
  await state.commands.get("rexxFlow.showControlGraph")();
  await state.panels[0].receiveMessage({
    type: "exportPngError",
    error: "Unable to export PNG because the graph image could not be rendered."
  });

  assert.match(state.errors[0], /graph image could not be rendered/);
});

test("top-level SVG and PNG export commands trigger the webview exporters", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rexx-flow-export-"));
  const sourceDoc = createDocument({
    fileName: path.join(tempDir, "sample.rex"),
    text: "say 'hi'"
  });
  const parserMock = {
    parseRexxControlFlow() {
      return createGraphFixture();
    },
    toDot() {
      return "";
    },
    toExcalidraw() {
      return "{}";
    }
  };
  const { vscodeMock, state } = createVscodeHarness({ document: sourceDoc });
  const extension = loadExtensionWithMocks({ vscodeMock, parserMock });

  extension.activate({ subscriptions: [], workspaceState: state.workspaceState });
  await state.commands.get("rexxFlow.exportSvg")();
  await state.commands.get("rexxFlow.exportPng")();

  assert.ok(state.postedMessages.some((message) => message.type === "triggerExportSvg"));
  assert.ok(state.postedMessages.some((message) => message.type === "triggerExportPng"));
});

test("persisted graph ui state is written to workspace state", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rexx-flow-state-"));
  const sourceDoc = createDocument({
    fileName: path.join(tempDir, "sample.rex"),
    text: "say 'hi'"
  });
  const parserMock = {
    parseRexxControlFlow() {
      return createGraphFixture();
    },
    toDot() {
      return "";
    },
    toExcalidraw() {
      return "{}";
    }
  };
  const { vscodeMock, state } = createVscodeHarness({ document: sourceDoc });
  const extension = loadExtensionWithMocks({ vscodeMock, parserMock });

  extension.activate({ subscriptions: [], workspaceState: state.workspaceState });
  await state.commands.get("rexxFlow.showControlGraph")();
  await state.panels[0].receiveMessage({
    type: "persistUiState",
    state: {
      selectedCaller: "MAIN",
      zoomScale: 1.5,
      nodeSearch: "MAIN",
      groupMode: "file",
      collapsedGroupIds: ["file:current"],
      filters: { call: true, signal: false, external: true, tso: true, dynamic: false },
      navigationHistory: ["MAIN"],
      navigationIndex: 0,
      focusModeEnabled: true,
      nodePositions: { MAIN: { x: 120, y: 200 } },
      pinnedNodeIds: ["MAIN"],
      snapToGrid: true
    }
  });

  const stored = state.workspaceState.get(`rexxFlow.uiState:${sourceDoc.uri.toString()}`, null);
  assert.equal(stored.selectedCaller, "MAIN");
  assert.equal(stored.groupMode, "file");
  assert.deepEqual(stored.nodePositions, { MAIN: { x: 120, y: 200 } });
  assert.deepEqual(stored.pinnedNodeIds, ["MAIN"]);
  assert.equal(stored.snapToGrid, true);
});

test("show command opens one panel per document and clears disposed document cache", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rexx-flow-multi-"));
  const firstDoc = createDocument({
    fileName: path.join(tempDir, "first.rex"),
    text: "say 'first'"
  });
  const secondDoc = createDocument({
    fileName: path.join(tempDir, "second.rex"),
    text: "say 'second'"
  });
  let parseCalls = 0;
  const parserMock = {
    parseRexxControlFlow() {
      parseCalls += 1;
      return createGraphFixture();
    },
    toDot() {
      return "";
    },
    toExcalidraw() {
      return "{}";
    }
  };
  const { vscodeMock, state } = createVscodeHarness({
    document: firstDoc,
    documents: [secondDoc]
  });
  const extension = loadExtensionWithMocks({ vscodeMock, parserMock });

  extension.activate({ subscriptions: [], workspaceState: state.workspaceState });

  await state.commands.get("rexxFlow.showControlGraph")();
  state.setActiveDocument(secondDoc);
  await state.commands.get("rexxFlow.showControlGraph")();

  assert.equal(state.panels.length, 2);
  assert.equal(parseCalls, 2);

  state.panels[0].dispose();
  state.setActiveDocument(firstDoc);
  await state.commands.get("rexxFlow.showControlGraph")();

  assert.equal(state.panels.length, 3);
  assert.equal(parseCalls, 3);
});
