const vscode = require("vscode");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { parseRexxControlFlow, toDot, toExcalidraw } = require("./parser");
const {
  normalizePersistedGraphState,
  createNonce,
  createGraphWebviewOptions,
  buildWebviewCsp,
  normalizeGraphWebviewMessage
} = require("./lib/shared");
const { renderGraphHtml, sanitizeCss, nodeCategoryForKind } = require("./lib/webview");
const {
  buildDiagnosticsForGraph,
  buildWorkspaceGraph,
  createLineRange,
  getFunctionAtLine
} = require("./lib/host-analysis");

const SUPPORTED_LANGS = new Set(["rexx", "REXX"]);
const MAX_CUSTOM_CSS_BYTES = 64 * 1024;
const MAX_UI_ERROR_CHARS = 180;
function activate(context) {
  const sessions = new Map();
  const graphCache = new Map();
  let cssWarningKey = null;
  const MAX_GRAPH_CACHE_ENTRIES = 8;

  const getSessionKey = (docOrUri) =>
    (docOrUri && docOrUri.uri ? docOrUri.uri : docOrUri)?.toString?.() || "";

  const getDocumentCacheKey = (doc) => `${doc.uri.toString()}::${Number(doc.version) || 0}`;

  const clearGraphCacheForDocument = (docOrUri) => {
    const uriKey = getSessionKey(docOrUri);
    for (const key of [...graphCache.keys()]) {
      if (key.startsWith(`${uriKey}::`)) {
        graphCache.delete(key);
      }
    }
  };

  const trimGraphCache = () => {
    while (graphCache.size > MAX_GRAPH_CACHE_ENTRIES) {
      const oldestKey = graphCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      graphCache.delete(oldestKey);
    }
  };

  const rememberGraphForDocument = (doc, graph) => {
    const key = getDocumentCacheKey(doc);
    graphCache.delete(key);
    graphCache.set(key, graph);
    trimGraphCache();
    return graph;
  };

  const getCachedGraphForDocument = (doc) => graphCache.get(getDocumentCacheKey(doc)) || null;

  const getGraphForDocument = (doc) => {
    const cached = getCachedGraphForDocument(doc);
    if (cached) {
      return cached;
    }
    return rememberGraphForDocument(doc, parseRexxControlFlow(doc.getText()));
  };

  const getSessionForDocument = (docOrUri) => sessions.get(getSessionKey(docOrUri)) || null;

  const formatOperationError = (error) => {
    const raw = error && typeof error.message === "string" ? error.message.trim() : "";
    if (!raw) {
      return "";
    }
    const compact = raw.replace(/\s+/g, " ");
    return compact.length > MAX_UI_ERROR_CHARS
      ? `${compact.slice(0, MAX_UI_ERROR_CHARS - 1)}…`
      : compact;
  };

  const showOperationError = (summary, error) => {
    const suffix = formatOperationError(error);
    vscode.window.showErrorMessage(
      `REXX Control Flow: ${summary}${suffix ? ` ${suffix}` : ""}`
    );
  };

  const runWithErrorMessage = async (summary, operation, options = {}) => {
    try {
      return await operation();
    } catch (error) {
      if (options.ignoreCodes && options.ignoreCodes.includes(error?.code)) {
        return null;
      }
      showOperationError(summary, error);
      return null;
    }
  };

  const withSupportedActiveDocument = async (unsupportedMessage, operation) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupported(editor.document)) {
      vscode.window.showWarningMessage(unsupportedMessage);
      return null;
    }
    return operation(editor.document);
  };

  const warnCustomCssIssue = (configuredPath, reasonKey, message) => {
    const key = `${configuredPath}:${reasonKey}`;
    if (cssWarningKey !== key) {
      cssWarningKey = key;
      vscode.window.showWarningMessage(`REXX Control Flow: ${message}`);
    }
  };

  const loadCustomCssForDocument = async (doc) => {
    const configuredPath = String(
      vscode.workspace.getConfiguration("rexxFlow").get("customCssFile", "")
    ).trim();
    if (!configuredPath) {
      cssWarningKey = null;
      return "";
    }

    const expandedPath = configuredPath.startsWith("~")
      ? path.join(os.homedir(), configuredPath.slice(1))
      : configuredPath;
    const isRelativePath = !path.isAbsolute(expandedPath);
    if (path.extname(expandedPath).toLowerCase() !== ".css") {
      warnCustomCssIssue(
        configuredPath,
        "extension",
        `Custom CSS file "${configuredPath}" must use the .css extension.`
      );
      return "";
    }
    if (isRelativePath && vscode.workspace.isTrusted === false) {
      warnCustomCssIssue(
        configuredPath,
        "untrusted",
        `Custom CSS file "${configuredPath}" is disabled for untrusted workspaces when using a relative path.`
      );
      return "";
    }

    let resolvedPath = expandedPath;
    if (isRelativePath) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);
      const basePath = workspaceFolder?.uri.fsPath || path.dirname(doc.fileName);
      resolvedPath = path.resolve(basePath, resolvedPath);
    }

    try {
      const stats = await fs.stat(resolvedPath);
      if (!stats.isFile()) {
        warnCustomCssIssue(
          configuredPath,
          "not-file",
          `Custom CSS file "${configuredPath}" is not a readable file.`
        );
        return "";
      }
      if (stats.size > MAX_CUSTOM_CSS_BYTES) {
        warnCustomCssIssue(
          configuredPath,
          "too-large",
          `Custom CSS file "${configuredPath}" exceeds the ${Math.round(
            MAX_CUSTOM_CSS_BYTES / 1024
          )} KB size limit.`
        );
        return "";
      }
      const css = await fs.readFile(resolvedPath, "utf8");
      cssWarningKey = null;
      return css;
    } catch (err) {
      warnCustomCssIssue(
        configuredPath,
        err?.code || "ERR",
        `Unable to load custom CSS file "${configuredPath}".`
      );
      return "";
    }
  };

  const getPersistenceKeyForSession = (sessionKey) => `rexxFlow.uiState:${sessionKey}`;

  const readPersistedState = (sessionKey) =>
    normalizePersistedGraphState(
      context.workspaceState?.get(getPersistenceKeyForSession(sessionKey), {}) || {}
    );

  const persistSessionState = async (session, state) => {
    if (!session?.persistenceKey || !context.workspaceState?.update) {
      return;
    }
    session.persistedState = normalizePersistedGraphState(state);
    await context.workspaceState.update(session.persistenceKey, session.persistedState);
  };

  const diagnosticCollection = vscode.languages?.createDiagnosticCollection
    ? vscode.languages.createDiagnosticCollection("rexxFlow")
    : null;

  const refreshDiagnosticsForDocument = async (doc) => {
    if (!diagnosticCollection) {
      return null;
    }
    if (!isSupported(doc)) {
      diagnosticCollection.delete(doc.uri);
      return null;
    }
    const graph = getGraphForDocument(doc);
    diagnosticCollection.set(doc.uri, buildDiagnosticsForGraph(vscode, doc, graph));
    return graph;
  };

  const refreshDiagnosticsQuietly = async (doc) => {
    if (!diagnosticCollection) {
      return;
    }
    try {
      await refreshDiagnosticsForDocument(doc);
    } catch {
      diagnosticCollection.delete(doc.uri);
    }
  };

  const syncSelectionToSession = (session, editor) => {
    if (!session || !session.panel || !session.documentUri || !session.graphData) {
      return;
    }
    if (!editor || editor.document.uri.toString() !== session.documentUri.toString()) {
      return;
    }

    const lineNo = (editor.selection?.active?.line || 0) + 1;
    const caller = getFunctionAtLine(session.graphData, lineNo);
    session.panel.webview.postMessage({ type: "selectCaller", caller, reveal: true });
  };

  const syncSelectionToGraph = (editor) => {
    if (!editor || !editor.document) {
      return;
    }
    const session = getSessionForDocument(editor.document);
    if (session) {
      syncSelectionToSession(session, editor);
    }
  };

  const renderSession = async ({
    session,
    graph,
    title,
    customCss = "",
    defaultViewMode = "graph",
    documentUri = null
  }) =>
    runWithErrorMessage(`Unable to render control flow for "${title}".`, async () => {
      session.graphData = graph;
      session.documentUri = documentUri;
      session.panel.title = `REXX Control Flow: ${title}`;
      if (session.panel.visible === false) {
        session.panel.reveal(vscode.ViewColumn.Beside, false);
      }

      session.panel.webview.html = renderGraphHtml(
        graph,
        title,
        customCss,
        defaultViewMode,
        createNonce(),
        session.persistedState || {}
      );

      if (documentUri) {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.toString() === documentUri.toString()) {
          syncSelectionToSession(session, activeEditor);
        }
      }
    });

  const renderSessionForDocument = async (doc, session) => {
    const currentNonce = ++session.renderNonce;
    const graph = await refreshDiagnosticsForDocument(doc);
    if (currentNonce !== session.renderNonce) {
      return null;
    }
    if (!graph) {
      return null;
    }
    const customCss = await loadCustomCssForDocument(doc);
    if (currentNonce !== session.renderNonce) {
      return null;
    }
    const defaultViewMode = String(
      vscode.workspace.getConfiguration("rexxFlow").get("defaultView", "graph")
    ).trim() === "detailed"
      ? "detailed"
      : "graph";
    return renderSession({
      session,
      graph,
      title: path.basename(doc.fileName),
      customCss,
      defaultViewMode,
      documentUri: doc.uri
    });
  };

  const handleSessionMessage = async (session, message) => {
    if (!message) {
      return;
    }

    if (message.type === "exportPngError") {
      vscode.window.showErrorMessage(`REXX Control Flow: ${message.error}`);
      return;
    }

    if (message.type === "persistUiState") {
      await persistSessionState(session, message.state);
      return;
    }

    if (message.type === "revealLine") {
      await runWithErrorMessage("Unable to reveal the requested source line.", async () => {
        const sessionUriStr = session.documentUri ? session.documentUri.toString() : null;
        const requestedUriStr = message.uri || null;
        if (requestedUriStr && requestedUriStr !== sessionUriStr) {
          return;
        }
        const targetUri = session.documentUri;
        if (!targetUri) {
          return;
        }
        const docTarget = await vscode.workspace.openTextDocument(targetUri);
        const line = Math.min(docTarget.lineCount - 1, message.line);
        const editor = await vscode.window.showTextDocument(docTarget, vscode.ViewColumn.One);
        const position = new vscode.Position(line - 1, 0);
        const range = new vscode.Range(position, position);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      });
      return;
    }

    await runWithErrorMessage("Unable to complete the requested graph action.", async () => {
      const docTarget = await getExportDocumentForSession(session);
      if (session.kind !== "workspace" && !isSupported(docTarget)) {
        return;
      }
      const graph = session.kind === "workspace" ? session.graphData : getGraphForDocument(docTarget);

      if (message.type === "exportGraphJson") {
        await exportJsonFromDocument(docTarget, graph);
        return;
      }

      if (message.type === "exportDot") {
        await exportDotFromDocument(docTarget, graph);
        return;
      }

      if (message.type === "exportExcalidraw") {
        await exportExcalidrawFromDocument(docTarget, graph);
        return;
      }

      if (message.type === "exportSvg") {
        await exportSvgFromDocument(docTarget, message.svg);
        return;
      }

      if (message.type === "exportPng") {
        await exportPngFromDocument(docTarget, message.png);
      }
    });
  };

  const createSessionForDocument = (doc) => {
    const key = getSessionKey(doc);
    const session = {
      kind: "document",
      sessionKey: key,
      persistenceKey: getPersistenceKeyForSession(key),
      persistedState: readPersistedState(key),
      panel: vscode.window.createWebviewPanel(
        "rexxControlFlow",
        `REXX Control Flow: ${path.basename(doc.fileName)}`,
        vscode.ViewColumn.Beside,
        createGraphWebviewOptions()
      ),
      documentUri: doc.uri,
      graphData: null,
      renderTimer: null,
      renderNonce: 0
    };

    session.panel.onDidDispose(() => {
      if (session.renderTimer) {
        clearTimeout(session.renderTimer);
        session.renderTimer = null;
      }
      sessions.delete(key);
      session.graphData = null;
      clearGraphCacheForDocument(session.documentUri);
    });

    session.panel.webview.onDidReceiveMessage(async (rawMessage) => {
      const message = normalizeGraphWebviewMessage(rawMessage);
      if (!message) {
        return;
      }
      await handleSessionMessage(session, message);
    });

    sessions.set(key, session);
    return session;
  };

  const createWorkspaceSession = () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const key = `workspace:${workspaceFolder?.uri?.toString?.() || "root"}`;
    const existing = sessions.get(key);
    if (existing) {
      return existing;
    }
    const session = {
      kind: "workspace",
      sessionKey: key,
      persistenceKey: getPersistenceKeyForSession(key),
      persistedState: readPersistedState(key),
      panel: vscode.window.createWebviewPanel(
        "rexxControlFlowWorkspace",
        "REXX Control Flow: Workspace",
        vscode.ViewColumn.Beside,
        createGraphWebviewOptions()
      ),
      documentUri: null,
      graphData: null,
      renderTimer: null,
      renderNonce: 0
    };
    session.panel.onDidDispose(() => {
      sessions.delete(key);
      session.graphData = null;
    });
    session.panel.webview.onDidReceiveMessage(async (rawMessage) => {
      const message = normalizeGraphWebviewMessage(rawMessage);
      if (!message) {
        return;
      }
      await handleSessionMessage(session, message);
    });
    sessions.set(key, session);
    return session;
  };

  const getOrCreateSessionForDocument = (doc) => {
    const existing = getSessionForDocument(doc);
    return {
      session: existing || createSessionForDocument(doc),
      created: !existing
    };
  };

  const renderForDocument = async (doc, options = {}) => {
    const createdSession = options.ensureSession ? getOrCreateSessionForDocument(doc) : null;
    const session = createdSession ? createdSession.session : getSessionForDocument(doc);
    if (!session) {
      return null;
    }
    try {
      return await renderSessionForDocument(doc, session);
    } catch (error) {
      if (createdSession?.created && !session.graphData && session.panel) {
        session.panel.dispose();
      }
      showOperationError(`Unable to render control flow for "${path.basename(doc.fileName)}".`, error);
      return null;
    }
  };

  const scheduleRender = (session, doc, delayMs = 120) => {
    if (session.renderTimer) {
      clearTimeout(session.renderTimer);
      session.renderTimer = null;
    }
    session.renderTimer = setTimeout(() => {
      session.renderTimer = null;
      void renderSessionForDocument(doc, session);
    }, delayMs);
  };

  const renderWorkspaceGraph = async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showWarningMessage("Open a workspace folder to generate workspace control flow.");
      return null;
    }
    return runWithErrorMessage("Unable to generate workspace control flow.", async () => {
      const files = await vscode.workspace.findFiles(
        "**/*.{rex,rexx,exec,REX,REXX,EXEC}",
        "**/{node_modules,.git,.omx,.codex}/**"
      );
      if (!files.length) {
        vscode.window.showWarningMessage("No REXX files were found in the current workspace.");
        return null;
      }
      const docs = [];
      for (const uri of files) {
        const doc = await vscode.workspace.openTextDocument(uri);
        if (isSupported(doc)) {
          docs.push(doc);
          await refreshDiagnosticsQuietly(doc);
        }
      }
      if (!docs.length) {
        vscode.window.showWarningMessage("No supported REXX files were found in the current workspace.");
        return null;
      }
      const session = createWorkspaceSession();
      const graph = buildWorkspaceGraph({
        docs,
        workspaceFolder,
        getGraphForDocument
      });
      const customCss = await loadCustomCssForDocument(docs[0]);
      const defaultViewMode = String(
        vscode.workspace.getConfiguration("rexxFlow").get("defaultView", "graph")
      ).trim() === "detailed"
        ? "detailed"
        : "graph";
      return renderSession({
        session,
        graph,
        title: `Workspace • ${workspaceFolder.name || "REXX"}`,
        customCss,
        defaultViewMode,
        documentUri: null
      });
    });
  };

  const scheduleWorkspaceRender = (delayMs = 180) => {
    const session = createWorkspaceSession();
    if (session.renderTimer) {
      clearTimeout(session.renderTimer);
      session.renderTimer = null;
    }
    session.renderTimer = setTimeout(() => {
      session.renderTimer = null;
      void renderWorkspaceGraph();
    }, delayMs);
  };

  const getWorkspaceExportDocument = () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const fileName = workspaceFolder?.uri?.fsPath
      ? path.join(workspaceFolder.uri.fsPath, "workspace-rexx-control-flow")
      : path.join(os.homedir(), "workspace-rexx-control-flow");
    return {
      fileName,
      uri: vscode.Uri.file(fileName),
      lineCount: 1,
      getText() {
        return "";
      }
    };
  };

  const getExportDocumentForSession = async (session) => {
    if (session?.documentUri) {
      return vscode.workspace.openTextDocument(session.documentUri);
    }
    return getWorkspaceExportDocument();
  };

  const getDefaultExportUri = (doc, extension) => {
    const safeExt = String(extension || "").replace(/^\./, "");
    const sourceName = path.basename(doc.fileName || "rexx-control-flow");
    const baseName = path.basename(sourceName, path.extname(sourceName));
    const defaultDir = path.dirname(doc.fileName || "");
    const defaultName = `${baseName}.${safeExt}`;
    if (defaultDir && defaultDir !== ".") {
      return vscode.Uri.file(path.join(defaultDir, defaultName));
    }
    return vscode.Uri.file(path.join(os.homedir(), defaultName));
  };

  const writeExportFile = async (doc, extension, data, filters) => {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: getDefaultExportUri(doc, extension),
      filters: filters || undefined
    });
    if (!uri) {
      return null;
    }
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    await fs.writeFile(uri.fsPath, payload);
    return uri;
  };

  const exportJsonFromDocument = async (doc, graph = getGraphForDocument(doc)) => {
    const uri = await writeExportFile(
      doc,
      "json",
      JSON.stringify(graph, null, 2),
      { JSON: ["json"] }
    );
    if (!uri) {
      return;
    }
    const target = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(target, vscode.ViewColumn.Beside);
  };

  const exportDotFromDocument = async (doc, graph = getGraphForDocument(doc)) => {
    const uri = await writeExportFile(doc, "dot", toDot(graph), { "Graphviz DOT": ["dot"] });
    if (!uri) {
      return;
    }
    const target = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(target, vscode.ViewColumn.Beside);
  };

  const exportExcalidrawFromDocument = async (doc, graph = getGraphForDocument(doc)) => {
    const uri = await writeExportFile(
      doc,
      "excalidraw",
      toExcalidraw(graph),
      { Excalidraw: ["excalidraw"] }
    );
    if (!uri) {
      return;
    }
    const target = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(target, vscode.ViewColumn.Beside);
  };

  const exportSvgFromDocument = async (doc, svgText) => {
    await writeExportFile(doc, "svg", svgText, { SVG: ["svg"] });
  };

  const exportPngFromDocument = async (doc, pngDataUrl) => {
    const clean = String(pngDataUrl || "").replace(/^data:image\/png;base64,/, "");
    if (!clean) {
      return;
    }
    await writeExportFile(doc, "png", Buffer.from(clean, "base64"), { PNG: ["png"] });
  };

  const requestSessionExport = async (session, type) => {
    if (!session?.panel?.webview) {
      return;
    }
    await session.panel.webview.postMessage({ type });
  };

  const triggerWebviewExport = async (doc, type) => {
    const createdSession = getOrCreateSessionForDocument(doc);
    const session = createdSession.session;
    const rendered = await renderSessionForDocument(doc, session);
    if (rendered === null) {
      return;
    }
    await session.panel.webview.postMessage({ type });
  };

  const show = vscode.commands.registerCommand("rexxFlow.showControlGraph", () =>
    withSupportedActiveDocument("Open a REXX file to generate control flow.", (doc) =>
      renderForDocument(doc, { ensureSession: true })
    )
  );

  const showWorkspace = vscode.commands.registerCommand(
    "rexxFlow.showWorkspaceControlGraph",
    () => renderWorkspaceGraph()
  );

  const exportJson = vscode.commands.registerCommand("rexxFlow.exportGraphJson", () =>
    withSupportedActiveDocument("Open a REXX file to export control flow.", (doc) =>
      runWithErrorMessage(`Unable to export JSON for "${path.basename(doc.fileName)}".`, () =>
        exportJsonFromDocument(doc)
      )
    )
  );

  const exportDot = vscode.commands.registerCommand("rexxFlow.exportDot", () =>
    withSupportedActiveDocument("Open a REXX file to export control flow.", (doc) =>
      runWithErrorMessage(`Unable to export DOT for "${path.basename(doc.fileName)}".`, () =>
        exportDotFromDocument(doc)
      )
    )
  );

  const exportExcalidraw = vscode.commands.registerCommand("rexxFlow.exportExcalidraw", () =>
    withSupportedActiveDocument("Open a REXX file to export control flow.", (doc) =>
      runWithErrorMessage(
        `Unable to export Excalidraw for "${path.basename(doc.fileName)}".`,
        () => exportExcalidrawFromDocument(doc)
      )
    )
  );

  const exportSvg = vscode.commands.registerCommand("rexxFlow.exportSvg", () =>
    withSupportedActiveDocument("Open a REXX file to export control flow.", (doc) =>
      runWithErrorMessage(`Unable to export SVG for "${path.basename(doc.fileName)}".`, () =>
        triggerWebviewExport(doc, "triggerExportSvg")
      )
    )
  );

  const exportPng = vscode.commands.registerCommand("rexxFlow.exportPng", () =>
    withSupportedActiveDocument("Open a REXX file to export control flow.", (doc) =>
      runWithErrorMessage(`Unable to export PNG for "${path.basename(doc.fileName)}".`, () =>
        triggerWebviewExport(doc, "triggerExportPng")
      )
    )
  );

  const onDocumentOpen = vscode.workspace.onDidOpenTextDocument((doc) => {
    void refreshDiagnosticsQuietly(doc);
    if (isSupported(doc) && [...sessions.values()].some((session) => session.kind === "workspace")) {
      scheduleWorkspaceRender();
    }
  });

  const onDocumentClose = vscode.workspace.onDidCloseTextDocument((doc) => {
    diagnosticCollection?.delete(doc.uri);
    if (isSupported(doc) && [...sessions.values()].some((session) => session.kind === "workspace")) {
      scheduleWorkspaceRender();
    }
  });

  const onDocumentChange = vscode.workspace.onDidChangeTextDocument((event) => {
    void refreshDiagnosticsQuietly(event.document);
    const session = getSessionForDocument(event.document);
    if (session) {
      scheduleRender(session, event.document);
    }
    if (isSupported(event.document) && [...sessions.values()].some((entry) => entry.kind === "workspace")) {
      scheduleWorkspaceRender();
    }
  });

  const onDocumentSave = vscode.workspace.onDidSaveTextDocument((doc) => {
    void refreshDiagnosticsQuietly(doc);
    const session = getSessionForDocument(doc);
    if (session) {
      scheduleRender(session, doc, 0);
    }
    if (isSupported(doc) && [...sessions.values()].some((entry) => entry.kind === "workspace")) {
      scheduleWorkspaceRender(0);
    }
  });

  const onSelectionChange = vscode.window.onDidChangeTextEditorSelection((event) => {
    syncSelectionToGraph(event.textEditor);
  });

  const onConfigChange = vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (
      !event.affectsConfiguration("rexxFlow.customCssFile") &&
      !event.affectsConfiguration("rexxFlow.defaultView")
    ) {
      return;
    }
    if (!sessions.size) {
      return;
    }

    await Promise.all(
      [...sessions.values()].map((session) =>
        runWithErrorMessage(
          "Unable to refresh the graph after settings changed.",
          async () => {
            if (session.kind === "workspace") {
              await renderWorkspaceGraph();
              return;
            }
            const doc = await vscode.workspace.openTextDocument(session.documentUri);
            await renderSessionForDocument(doc, session);
          },
          { ignoreCodes: ["ENOENT", "FileNotFound"] }
        )
      )
    );
  });

  const codeLensProvider = vscode.languages?.registerCodeLensProvider
    ? vscode.languages.registerCodeLensProvider(
        [{ language: "rexx" }, { language: "REXX" }],
        {
          provideCodeLenses(doc) {
            if (!isSupported(doc)) {
              return [];
            }
            const range = createLineRange(vscode, doc, 1);
            return [
              new vscode.CodeLens(range, {
                title: "Show Control Flow",
                command: "rexxFlow.showControlGraph"
              }),
              new vscode.CodeLens(range, {
                title: "Workspace Graph",
                command: "rexxFlow.showWorkspaceControlGraph"
              }),
              new vscode.CodeLens(range, {
                title: "Export JSON",
                command: "rexxFlow.exportGraphJson"
              }),
              new vscode.CodeLens(range, {
                title: "Export PNG",
                command: "rexxFlow.exportPng"
              })
            ];
          }
        }
      )
    : null;

  if (Array.isArray(vscode.workspace.textDocuments)) {
    for (const doc of vscode.workspace.textDocuments) {
      void refreshDiagnosticsQuietly(doc);
    }
  }

  context.subscriptions.push(
    ...[
      show,
      showWorkspace,
      exportJson,
      exportDot,
      exportExcalidraw,
      exportSvg,
      exportPng,
      onDocumentOpen,
      onDocumentClose,
      onDocumentChange,
      onDocumentSave,
      onSelectionChange,
      onConfigChange,
      diagnosticCollection,
      codeLensProvider
    ].filter(Boolean)
  );
}

function isSupported(doc) {
  if (SUPPORTED_LANGS.has(doc.languageId)) {
    return true;
  }
  const name = doc.fileName.toLowerCase();
  return name.endsWith(".rexx") || name.endsWith(".rex") || name.endsWith(".exec");
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  buildWebviewCsp,
  createGraphWebviewOptions,
  createNonce,
  nodeCategoryForKind,
  normalizeGraphWebviewMessage,
  renderGraphHtml,
  sanitizeCss
};
