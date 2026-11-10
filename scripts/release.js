const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function versionParts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return version.split(".").map(Number);
}

function createReleasePlan(args, manifest, env) {
  let requestedVersion = "";
  let useCurrent = false;
  let only = "both";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--current") {
      useCurrent = true;
    } else if (arg === "--only") {
      only = args[++index];
    } else if (!arg.startsWith("-") && !requestedVersion) {
      requestedVersion = arg;
    } else {
      throw new Error(`Unknown release argument: ${arg}`);
    }
  }

  if (useCurrent && requestedVersion) {
    throw new Error("Choose a version or --current, not both.");
  }
  if (!["both", "marketplace", "open-vsx"].includes(only)) {
    throw new Error("--only must be marketplace or open-vsx.");
  }

  const currentParts = versionParts(manifest.version);
  const version = requestedVersion || (useCurrent
    ? manifest.version
    : `${currentParts[0]}.${currentParts[1]}.${currentParts[2] + 1}`);
  const targetParts = versionParts(version);
  const firstDifference = targetParts.findIndex((part, index) => part !== currentParts[index]);
  if (firstDifference >= 0 && targetParts[firstDifference] < currentParts[firstDifference]) {
    throw new Error(`Release version ${version} is older than ${manifest.version}.`);
  }

  if (only !== "open-vsx" && !env.VSCE_PAT && env.VSCE_AZURE_CREDENTIAL !== "1") {
    throw new Error("Set VSCE_PAT or VSCE_AZURE_CREDENTIAL=1 before publishing to Marketplace.");
  }
  if (only !== "marketplace" && !env.OVSX_PAT) {
    throw new Error("Set OVSX_PAT before publishing to Open VSX.");
  }

  return { version, only };
}

function runRelease({
  args = process.argv.slice(2),
  cwd = path.resolve(__dirname, ".."),
  env = process.env,
  manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")),
  run = (command, commandArgs) => execFileSync(command, commandArgs, { cwd, env, stdio: "inherit" })
} = {}) {
  const plan = createReleasePlan(args, manifest, env);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const vsixPath = path.join(cwd, `${manifest.name}-${plan.version}.vsix`);

  run(npm, ["run", "verify"]);
  if (plan.version !== manifest.version) {
    run(npm, ["version", plan.version, "--no-git-tag-version"]);
  }
  run(npm, ["run", "package:vsix"]);

  if (plan.only !== "open-vsx") {
    const authArgs = env.VSCE_AZURE_CREDENTIAL === "1" ? ["--azure-credential"] : [];
    run(npx, ["--yes", "@vscode/vsce", "publish", "--packagePath", vsixPath, ...authArgs]);
  }
  if (plan.only !== "marketplace") {
    run(npx, ["--yes", "ovsx", "publish", vsixPath]);
  }
}

if (require.main === module) {
  try {
    runRelease();
  } catch (error) {
    console.error(`Release failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createReleasePlan, runRelease };
