"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const root = path.resolve(__dirname, "..");
const [mode, ...args] = process.argv.slice(2);
const usage = "Usage: node scripts/reproduce_paper.js wan CONFIG [OUTPUT_DIR] | workflow [OUTPUT_DIR] [TASKS_PER_SCENARIO]";
if (["-h", "--help"].includes(mode) || args.includes("--help")) {
  console.log(usage);
  process.exit(0);
}
if (!["wan", "workflow"].includes(mode)) {
  console.error(usage);
  process.exit(2);
}
require("dotenv").config({ path: path.join(root, ".env") });
const env = { ...process.env, CI: "true", HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" };
function run(file, parameters = [], extra = {}) {
  const result = spawnSync(process.execPath, [path.resolve(root, file), ...parameters],
    { cwd: root, stdio: "inherit", env: { ...env, ...extra } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
if (mode === "workflow") {
  const tasks = Number(args[1] || 100);
  if (args.length > 2 || !Number.isInteger(tasks) || tasks < 1 || tasks > 1000) {
    throw new Error("Use OUTPUT_DIR and 1..1000 tasks per scenario (100 for the paper workload)");
  }
  const output = path.resolve(root, args[0] || `runtime/task-workflow-${stamp}`);
  if (fs.existsSync(output)) throw new Error("Choose a new output directory");
  run("scripts/paper/task_workflow.cjs", ["--project-root", root, "--out", output, "--tasks", String(tasks)]);
} else {
  if (!args[0] || args.length > 2) throw new Error(usage);
  if (env.ALLOW_REAL_WAN_EXPERIMENT !== "1") throw new Error("Set ALLOW_REAL_WAN_EXPERIMENT=1");
  for (const key of ["WAN_SSH_KEY_PATH", "WAN_KNOWN_HOSTS_PATH"]) {
    if (!env[key]) throw new Error(`Set ${key} for your two-host deployment`);
  }
  const configPath = path.resolve(root, args[0]);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!config.remote || /YOUR_|\/ABSOLUTE\//.test(JSON.stringify(config.remote))) {
    throw new Error("Replace the remote placeholders in your local WAN configuration");
  }
  const output = path.resolve(root, args[1] || `runtime/wan-paper-${stamp}`);
  if (fs.existsSync(output)) throw new Error("Choose a new output directory");
  run("scripts/wan/cache-host.js");
  const preload = path.join(root, "scripts/wan/static-host-metadata.cjs");
  run("scripts/paper/wan_campaign.cjs", ["--project-root", root, "--config", configPath,
    "--out", output, "--rounds", "3", "--levels", "1,4,8,16", "--modes", "local,remote"],
    { NODE_OPTIONS: [env.NODE_OPTIONS || "", "--require", JSON.stringify(preload)].join(" ").trim() });
}
