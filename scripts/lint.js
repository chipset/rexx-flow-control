const fs = require("node:fs");
const path = require("node:path");

const files = [
  "extension.js",
  "parser.js",
  "extension.test.js",
  "extension.integration.test.js",
  path.join("lib", "shared.js"),
  path.join("lib", "host-analysis.js"),
  path.join("lib", "host-analysis.test.js"),
  path.join("lib", "webview.js"),
  path.join("lib", "webview-render.js"),
  path.join("lib", "webview-support.js"),
  "parser.test.js",
  path.join("scripts", "lint.js"),
  path.join("vscode-test", "runTest.js"),
  path.join("vscode-test", "index.js"),
  path.join("vscode-test", "extension-host.js")
];

const violations = [];

for (const file of files) {
  const text = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const lines = text.split(/\n/);
  lines.forEach((line, index) => {
    if (/\s+$/.test(line)) {
      violations.push(`${file}:${index + 1} trailing whitespace`);
    }
    if (/\t/.test(line)) {
      violations.push(`${file}:${index + 1} tab character`);
    }
  });
}

if (violations.length) {
  console.error("Lint violations found:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(`Lint passed for ${files.length} files.`);
