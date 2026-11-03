/* Targeted Fig. 3(a) diagnostic. Does not edit the original benchmark or provider.
 * Run from the coordinator with the existing project dependencies and WAN env.
 * Example: node diagnostic_wan_runner.cjs --project-root /root/JNCA 
 *   --config /root/JNCA/reproducibility/submission-20261015/wan-key-static-config.json
 *   --remote-port 53251 --out /root/JNCA/.codex-runtime/wan-tail-NEW --rounds 3
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { execFile } = require("child_process");
const { monitorEventLoopDelay, performance, PerformanceObserver } = require("perf_hooks");

function options(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) throw new Error("Use --name value pairs");
    parsed[argv[i].slice(2)] = argv[i + 1];
  }
  for (const key of ["project-root", "config", "out"]) if (!parsed[key]) throw new Error(`Missing --${key}`);
  return parsed;
}
const opts = options(process.argv.slice(2));
const root = path.resolve(opts["project-root"]);
const out = path.resolve(opts.out);
if (fs.existsSync(out)) throw new Error("Output directory already exists; choose a new path");
const configPath = path.resolve(opts.config);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const sourceCampaignId = config.campaignId;
config.campaignId = `wan-tail-diagnostic-${new Date().toISOString().replace(/[:.]/g, "-")}`;
if (opts["remote-port"]) config.remote.port = Number(opts["remote-port"]);
if (opts["remote-host"]) config.remote.host = opts["remote-host"];
const rounds = Number(opts.rounds || 3);
const levels = (opts.levels || "4,8,16").split(",").map(Number);
const modes = (opts.modes || "local,remote").split(",");
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 20) throw new Error("Invalid rounds");
if (levels.some(c => ![1, 4, 8, 16].includes(c)) || modes.some(m => !["local", "remote"].includes(m))) throw new Error("Invalid levels or modes");
if (modes.includes("remote") && process.env.ALLOW_REAL_WAN_EXPERIMENT !== "1") throw new Error("ALLOW_REAL_WAN_EXPERIMENT=1 required");
for (const [key, expected] of Object.entries({warmupSamples:10, measuredSamples:100, payloadBytes:4096, serviceDelayMs:5})) {
  if (config.protocol[key] !== expected) throw new Error(`Original protocol.${key} must remain ${expected}`);
}
fs.mkdirSync(out, {recursive: true});
const now = () => Number(process.hrtime.bigint()) / 1e6;
const hash = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const json = (p, v) => fs.writeFileSync(path.join(out, p), JSON.stringify(v, null, 2) + "\n");
const lines = (p, values) => fs.writeFileSync(path.join(out, p), values.map(v => JSON.stringify(v)).join("\n") + "\n");
const {summarize} = require(path.join(root, "lib/v2/experiment-utils.js"));
const wanPath = path.join(root, "scripts/v2/benchmark_wan_v2.js");
const protocolPath = path.join(root, "scripts/v2/benchmark_protocol_v2.js");
let context = null;

// In-memory wrapping only. The original timing functions and group scheduler run unchanged.
const protocol = require(protocolPath);
const originalRunCall = protocol.runCall;
protocol.runCall = function(environment, callOptions) {
  const target = context;
  const event = {kind:"call", iteration:callOptions.iteration, warmup:callOptions.warmup, startMs:now()};
  return originalRunCall(environment, callOptions).then(value => {
    event.endMs = now();
    if (target) target.timeline.push(event);
    return value;
  }, error => {
    event.endMs = now(); event.error = error.message;
    if (target) target.timeline.push(event);
    throw error;
  });
};
const loaded = new Module(wanPath, module);
loaded.filename = wanPath;
loaded.paths = Module._nodeModulePaths(path.dirname(wanPath));
const source = fs.readFileSync(wanPath, "utf8");
if (!source.includes("if (require.main === module)")) throw new Error("Cannot safely suppress original main");
loaded._compile(source + "\nmodule.exports = {executeProtocolSetting, JsonLineTransport};\n", wanPath);
const {executeProtocolSetting, JsonLineTransport} = loaded.exports;
const originalRequest = JsonLineTransport.prototype.request;
JsonLineTransport.prototype.request = function(message, timeoutMs) {
  const target = context;
  if (!target || message.type !== "invoke") return originalRequest.call(this, message, timeoutMs);
  const event = {kind:"provider-request", iteration:message.seed-config.randomSeed, startMs:now(), pendingAtStart:this.pending.size};
  return originalRequest.call(this, message, timeoutMs).then(value => {
    event.endMs = now(); event.requestId = value.requestId; event.remoteServiceMs = value.serviceMs;
    target.timeline.push(event);
    return value;
  }, error => {
    event.endMs = now(); event.error = error.message; target.timeline.push(event); throw error;
  });
};

function procSnapshot() {
  const result = {atMs:now()};
  for (const file of ["/proc/net/snmp", "/proc/net/netstat", "/proc/self/status", "/proc/pressure/cpu", "/proc/pressure/io"]) {
    try { result[file] = fs.readFileSync(file, "utf8"); } catch (_) { /* optional on non-Linux */ }
  }
  return result;
}
function socketSnapshot() {
  if (!context || context.mode !== "remote") return Promise.resolve(null);
  return new Promise(resolve => {
    execFile("ss", ["-tinp", "dport", "=", `:${config.remote.port}`], {timeout:5000, maxBuffer:1024*1024}, (error, stdout, stderr) => {
      resolve({atMs:now(), text:stdout, error:error ? error.message : null, stderr});
    });
  });
}
const originalStart = JsonLineTransport.prototype.start;
JsonLineTransport.prototype.start = async function() {
  const value = await originalStart.call(this);
  if (context) {
    context.socketBefore = await socketSnapshot();
    context.procBefore = procSnapshot();
    context.monitorStartMs = now();
    context.cpuStart = process.cpuUsage();
    context.utilizationStart = performance.eventLoopUtilization();
    context.resourceStart = process.resourceUsage();
    context.loop.reset();
  }
  return value;
};
const originalClose = JsonLineTransport.prototype.close;
JsonLineTransport.prototype.close = async function() {
  if (context && !context.monitorStopped) {
    context.monitorStopped = true;
    context.monitorEndMs = now();
    context.cpu = process.cpuUsage(context.cpuStart);
    context.utilization = performance.eventLoopUtilization(context.utilizationStart);
    context.resourceEnd = process.resourceUsage();
    context.loopSummaryMs = {
      mean:context.loop.mean/1e6, p95:context.loop.percentile(95)/1e6,
      p99:context.loop.percentile(99)/1e6, max:context.loop.max/1e6,
    };
    context.procAfter = procSnapshot();
    context.socketAfter = await socketSnapshot();
  }
  return originalClose.call(this);
};

const schedule = [];
for (let round = 1; round <= rounds; round++) {
  const shift = (round-1) % levels.length;
  const order = levels.slice(shift).concat(levels.slice(0, shift));
  for (const concurrency of order) {
    const modeOrder = round % 2 ? modes : [...modes].reverse();
    for (const mode of modeOrder) schedule.push({round, mode, concurrency});
  }
}
const sources = Object.fromEntries([wanPath, protocolPath, path.join(root,"scripts/v2/wan_provider_stdio.js"), path.join(root,"lib/v2/experiment-utils.js")].map(p => [path.relative(root,p),hash(p)]));
json("manifest.json", {createdAt:new Date().toISOString(), sourceCampaignId, sourceConfigSha256:hash(configPath), effectiveConfig:config, sources, runnerSha256:hash(__filename), runtime:process.version, schedule,
  methodology:"Original executeProtocolSetting, fixed Promise.all groups, unchanged seed/setting IDs, 10 warmup + 100 measured, 4096 bytes, 5 ms deterministic service. Only diagnostic observers added.",
  scope:"Tail-latency diagnosis only. Existing report includes complete-window metadata incidentally; this is not the deferred dedicated goodput experiment.",
  caveats:["Provider-request RTT includes SSH/stdio and coordinator scheduling; it is not pure wire RTT.","Event-loop measurements cover warmup plus measured range; per-call timestamps identify measured overlap.","/proc network counters are host/global and cannot alone establish flow-specific loss.","ss snapshots are taken outside protocol calls; match the SSH PID before interpreting counters.","No provider code changes; remote serviceMs captures timer scheduling + payload/hash but excludes final base64/JSON/stdio transmission.","Observers introduce small overhead; these diagnostic repetitions do not silently replace the published campaign."]});

async function main() {
  const allRows = [], reports = [];
  for (const setting of schedule) {
    const id = `r${setting.round}-${setting.mode}-c${setting.concurrency}`;
    context = {...setting, id, timeline:[], samples:[], gc:[], loop:monitorEventLoopDelay({resolution:10})};
    context.loop.enable();
    const target = context;
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) target.gc.push({kind:entry.detail?.kind, startPerformanceMs:entry.startTime, durationMs:entry.duration});
    });
    observer.observe({entryTypes:["gc"]});
    const performanceAnchor = {monoMs:now(), performanceMs:performance.now(), wallTime:new Date().toISOString()};
    let last = now(), previousCpu = process.cpuUsage();
    const timer = setInterval(() => {
      const atMs = now();
      const cpuNow = process.cpuUsage();
      target.samples.push({atMs, sampleIntervalMs:atMs-last, timerOvershootMs:Math.max(0,atMs-last-100), cpuUserUs:cpuNow.user-previousCpu.user, cpuSystemUs:cpuNow.system-previousCpu.system, rssBytes:process.memoryUsage().rss});
      previousCpu = cpuNow; last = atMs;
    }, 100);
    try {
      const result = await executeProtocolSetting(config, setting.mode, setting.concurrency);
      const rows = result.rows.map(row => ({...row, diagnosticRun:id, round:setting.round,
        groupIndex:Math.floor((row.iteration-1-(row.warmup?0:config.protocol.warmupSamples))/setting.concurrency),
      }));
      const measured = rows.filter(row => !row.warmup);
      const metrics = Object.fromEntries(["totalMs","networkRoundTripMs","remoteServiceMs","transportOverheadMs","delegationSignatureMs","authorizationMs","modelRequestMs","encryptedCommitMs","buyerVerificationMs","buyerConfirmationSignatureMs","keyReleaseMs","decryptMs","chunkElapsedMs"].map(key => [key,summarize(measured.map(row=>row[key]))]));
      const report = {...setting,id,metrics, originalReport:result.report,providerHello:result.providerHello};
      allRows.push(...rows); reports.push(report);
      lines(`${id}-raw.jsonl`, rows);
      lines(`${id}-timeline.jsonl`, target.timeline);
      json(`${id}-diagnostics.json`, {...target, loop:undefined, timeline:undefined, cpuStart:undefined, utilizationStart:undefined, performanceAnchor});
      json(`${id}-summary.json`, report);
      json("summary.json",reports);
      console.log(JSON.stringify({id,totalMeanMs:metrics.totalMs.mean,totalP95Ms:metrics.totalMs.p95,transportP95Ms:metrics.transportOverheadMs.p95,remoteServiceP95Ms:metrics.remoteServiceMs.p95,eventLoopMaxMs:target.loopSummaryMs?.max}));
    } finally {
      clearInterval(timer); observer.disconnect(); target.loop.disable(); context=null;
    }
  }
  lines("all-raw.jsonl",allRows);
}
main().catch(error => {
  json("failure.json",{at:new Date().toISOString(), error:error.stack, setting:context ? {id:context.id,round:context.round,mode:context.mode,concurrency:context.concurrency} : null});
  console.error(error.stack); process.exitCode=1;
});
