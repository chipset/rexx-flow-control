const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createReleasePlan, runRelease } = require("./release");

const manifest = { name: "rexx-control-flow", publisher: "TMcQ", version: "0.2.1" };
const credentials = { VSCE_PAT: "marketplace-token", OVSX_PAT: "open-vsx-token" };

test("release plan bumps the patch by default and accepts the current version", () => {
  assert.equal(createReleasePlan([], manifest, credentials).version, "0.2.2");
  assert.equal(createReleasePlan(["0.2.1"], manifest, credentials).version, "0.2.1");
  assert.equal(createReleasePlan(["--current"], manifest, credentials).version, "0.2.1");
  assert.throws(() => createReleasePlan(["0.2.0"], manifest, credentials), /older/);
  assert.throws(() => createReleasePlan(["not-a-version"], manifest, credentials), /version/);
});

test("release requires credentials before changing files or publishing", () => {
  const calls = [];
  assert.throws(() => runRelease({
    args: ["--current"],
    manifest,
    env: { VSCE_PAT: "marketplace-token" },
    run: (...call) => calls.push(call)
  }), /OVSX_PAT/);
  assert.deepEqual(calls, []);
});

test("release builds one VSIX and publishes that file to both registries", () => {
  const calls = [];
  runRelease({
    args: ["--current"],
    manifest,
    env: credentials,
    cwd: "/tmp/rexx-release-test",
    run: (command, args) => calls.push([command, args])
  });

  const vsix = path.join("/tmp/rexx-release-test", "rexx-control-flow-0.2.1.vsix");
  assert.deepEqual(calls, [
    ["npm", ["run", "verify"]],
    ["npm", ["run", "package:vsix"]],
    ["npx", ["--yes", "@vscode/vsce", "publish", "--packagePath", vsix]],
    ["npx", ["--yes", "ovsx", "publish", vsix]]
  ]);
});

test("default release updates the patch version before packaging", () => {
  const calls = [];
  runRelease({
    manifest,
    env: credentials,
    run: (command, args) => calls.push([command, args])
  });
  assert.deepEqual(calls[1], ["npm", ["version", "0.2.2", "--no-git-tag-version"]]);
  assert.match(calls[3][1][4], /rexx-control-flow-0\.2\.2\.vsix$/);
});

test("Microsoft Entra credential mode passes the Marketplace flag", () => {
  const calls = [];
  runRelease({
    args: ["--current", "--only", "marketplace"],
    manifest,
    env: { VSCE_AZURE_CREDENTIAL: "1" },
    run: (command, args) => calls.push([command, args])
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2][1].at(-1), "--azure-credential");
});

test("release can retry Open VSX without republishing to Marketplace", () => {
  const calls = [];
  runRelease({
    args: ["--current", "--only", "open-vsx"],
    manifest,
    env: { OVSX_PAT: "open-vsx-token" },
    run: (command, args) => calls.push([command, args])
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2][1].slice(0, 3), ["--yes", "ovsx", "publish"]);
});

test("release stops after a failed Marketplace publish", () => {
  const calls = [];
  assert.throws(() => runRelease({
    args: ["--current"],
    manifest,
    env: credentials,
    run: (command, args) => {
      calls.push([command, args]);
      if (args.includes("publish")) {
        throw new Error("Marketplace rejected upload");
      }
    }
  }), /Marketplace rejected upload/);
  assert.equal(calls.length, 3);
});
