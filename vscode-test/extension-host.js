const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

async function waitFor(check, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const started = Date.now();
  let lastError = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw lastError || new Error("Timed out waiting for extension-host condition.");
}

function getGraphTabLabels() {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .map((tab) => tab.label)
    .filter((label) => /^REXX Control Flow: /.test(label));
}

async function openAndRender(fileName) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "Expected the fixture workspace to be open.");

  const target = vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, fileName));
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("rexxFlow.showControlGraph");

  await waitFor(() =>
    getGraphTabLabels().includes(`REXX Control Flow: ${path.basename(document.fileName)}`)
  );
}

async function run() {
  const extension = vscode.extensions.getExtension("TMcQ.rexx-control-flow");
  assert.ok(extension, "Expected the extension under test to be installed.");
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("rexxFlow.showControlGraph"));
  assert.ok(commands.includes("rexxFlow.exportGraphJson"));

  await openAndRender("sample-one.rex");
  await openAndRender("sample-two.rex");

  await waitFor(() => getGraphTabLabels().length >= 2);
}

module.exports = { run };
