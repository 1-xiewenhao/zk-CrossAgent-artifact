# Measurements used by the TSC manuscript

This archive accompanies **zk-CrossAgent: Task-Bounded Service Invocation and
Asynchronous Cross-Chain Settlement**. It contains the campaigns used by the
current manuscript, including the complete adopted WAN performance campaign and
the task-workflow correctness campaign. Superseded campaigns and diagnostic
trials are not included in this publication dataset.

The directory date identifies this artifact package. It does not imply that all
experiments ran on that date or in one campaign. The local, model-service,
public-testnet, formal-verification, WAN performance, WAN recovery, and workflow
records retain their respective acquisition dates and provenance. Packaging does
not create new observations or change their measured values.

## Recalculate without external services

From the repository root, using Python 3.9 or later (standard library only):

```sh
python scripts/recalculate_paper.py --output tmp/paper-statistics.json
```

The command checks the published SHA-256 inventory, recalculates summaries from
retained observations, checks complete measurement windows, regenerates the
seeded batching simulation, and checks the workflow accounting records. It
exports the values used in the paper's tables and figures. It does not run
benchmarks, connect to a blockchain, or call a model API. Preserved verification
reports document the authors' executions; reading them is not an independent
execution of those models or tests.

## Mapping to the manuscript

| Evidence | Files | Manuscript use |
| --- | --- | --- |
| 1,090 local invocations; 130 warm-ups | `local/protocol_raw.jsonl`, matching summaries | Abstract, VI-B1, Figure 2(a), local throughput |
| 40 proofs; 4 warm-ups | `local/zk_raw.jsonl`, matching summaries | VI-C, Table II; witness and verification times are distinct |
| 18 seeded batching configurations, 5,000 arrivals each | `local/campaign_config.json`, `local/batch_policy_summary.json` | VI-C; 90,000 arrivals regenerated from the retained seed |
| 400 local relay-recovery rounds; 20 warm-ups | `fault-gas/fault_raw.jsonl`, matching summaries | VI-E(a), Table V |
| 104 local transactions/deployments | `fault-gas/local_gas_raw.jsonl`, matching summaries | VI-D, withdrawal/release cost |
| 128 derived policy rows from 16 matched component repetitions | `fault-gas/gas_policy_baseline_raw.jsonl`, matching summaries and comparisons | Table III and 22.34% amortization; these are not 128 additional transactions |
| 10 paid model calls; 1 warm-up | `llm/real_llm_raw.jsonl`, matching summaries | VI-B2, Figure 2(b) |
| 2,400 WAN protocol calls; 240 warm-ups; 24 complete windows | `wan/` run records, summaries, timelines and `complete-measurement-windows.json` | VI-B3, Figure 3 |
| 20 independent WAN provider-recovery rounds; 2 warm-ups | `wan-recovery/wan_recovery_raw.jsonl`, `wan-recovery/summary.json` | VI-E(b); separate from Figure 3 |
| 5 public-testnet rounds; 1 warm-up | `testnet/testnet_v2_raw.jsonl`, matching summaries | VI-D, Table IV |
| One unused-root withdrawal sequence | `testnet/withdrawal_public_testnet.jsonl` | VI-D; five confirmed transactions, including setup |
| 600 tasks across six workflow scenarios | `task-workflow/` exported records, accounting trace and summary | VI-F, Figure 4; 1,800 confirmed settlements and 8,700 accounting snapshots |
| ProVerif, bounded state exploration and implementation checks | `verification/` | V-C and VI-A1; preserved execution reports |

Table I lists campaign sample counts. Figure 1 is an architectural diagram.
Source provenance is recorded in `docs/SOURCE_PROVENANCE.json` at the repository
root; data hashes and transformations are recorded in `manifest.json` here.

## Statistics and units

- A JSONL line is one record. Exclude records marked `warmup: true` when computing
  measured-call summaries. No observations within the published campaigns are
  removed as outliers. Gas observations and derived Gas-policy rows have no
  warm-up field and are all retained.
- `*Ms` fields are milliseconds; the tables convert selected values to seconds.
  Gas is an execution-unit count, not a currency amount. Payload sizes are bytes.
- Percentiles use linear interpolation at rank `(n - 1) * p`, with `p` in `[0, 1]`.
  The sample standard deviation uses divisor `n - 1`.
- Existing `ci95` fields use `mean +/- 1.96 * sample_sd / sqrt(n)`. These normal
  approximations do not establish small-sample coverage. The paper reports means
  and descriptive percentiles, not population-tail guarantees.
- Throughput/goodput is completed calls divided by the complete measurement
  window, not inverse mean latency. Any legacy aggregate throughput fields
  repeated in percentile/CI columns are not distributions or uncertainty bounds.

## WAN performance: three complete runs

Figure 3 uses only the adopted full campaign in `wan/`: three repetitions of
same-host and cross-region execution at concurrency 1, 4, 8, and 16. Each
repetition retains 100 calls after 10 warm-ups for every setting. The resulting
2,400 measured calls and 240 warm-ups belong to 24 independently timed setting
windows. Per-run files use the `r{run}-{local,remote}-c{concurrency}` prefix.

For each placement/concurrency pair, concatenate the three sets of 100 measured
call latencies before computing the mean and percentiles. The reported goodput is:

```text
300 / (sum(measuredElapsedMs over the three windows) / 1000)
```

The denominator is retained in `complete-measurement-windows.json`, in each
entry's `originalReport.measuredElapsedMs`; completed counts are in
`originalReport.measuredSamples`. These are recorded complete-window timers,
not values reconstructed from reported goodput. Do not substitute summed
`chunkElapsedMs`, sum per-call latency, or average the three per-run goodputs.
The associated summaries and timelines allow checks against the per-call records.

The 20-round provider-recovery experiment in `wan-recovery/` is a separate
campaign. It measures detection, session re-establishment, and a retried response
while the coordinator remains running. Its total timer is recorded independently
from the phase timers. It is not an extra repetition of the Figure 3 sweep.

## Task-workflow correctness

`task-workflow/` retains `tasks.jsonl`, `calls.jsonl`, `rejections.jsonl`,
`settlements.jsonl`, `batch-acceptance.jsonl`, and `accounting-trace.jsonl`, plus
campaign metadata and the summary. `protocol.sqlite.gz` preserves the compressed
durable-state database. The JSONL exports support the offline accounting audit
without requiring SQLite or decompressing the database.

The six scenarios each contain 100 independent tasks: a dependent chain, budget
contention, call-count contention, pre-commit failure replacement, interrupted
reconciliation, and an integrated workflow. The default budget/call bound is
30 units/3 calls. The budget-only and count-only controls instead use 25/10 and
100/3. Controlled services charge 5, 10, and 15 units, including orchestration
fees. Four worker processes with separate SQLite connections share one gateway
state domain in the contention tests.

The 600 tasks produce 1,800 confirmed receipt settlements and 8,700 recorded
accounting snapshots. In the integrated workflow, an aborted pre-commit branch
releases its reservation but retains the consumed nonce. Local reconciliation
moves usage from reserved to settled without restoring task allowance. Figure 4
shows the first integrated task in event order, not elapsed time.

These are controlled correctness observations. A local-EVM test endpoint accepts
batch roots directly; this campaign does not execute fresh Groth16 proving or
source-chain relay verification. Closing and reopening local durable state tests
interrupted reconciliation, not a relayer-process crash. Duplicate settlement
checks use `callStatic`; they are not additional submitted failing transactions.
The results do not establish implementation-wide safety under arbitrary contention
or correctness of model-service semantics.

## Table IV: timing boundaries

For each of the five non-warm-up testnet rounds, the residual in seconds is:

```text
(endToEndMs - proveMs - registerBatchFinalityMs
 - relayAcceptFinalityMs - settleFinalityMs) / 1000
```

The total mean is 133.05813366 s. The four component means sum to 98.28080108 s;
the residual mean is 34.77733258 s (reported as 34.78 s), and the P95 of the
five residuals is 55.15500025 s (reported as 55.16 s). Each displayed value is
rounded independently. Percentiles are not additive.

The three chain timers begin after the transaction-submission call returns.
The enclosing registration-to-settlement timer starts before submission and
includes intervening contract queries and receipt signatures. The residual
therefore covers preparation/submission and inter-stage coordination. It is
derived, not separately instrumented; individual RPC, retry and signing costs
cannot be reconstructed. Testnet `proveMs` includes witness generation through
`fullProve`, while the local `zk` campaign records witness generation separately.
The enclosing total excludes input construction, off-chain proof verification,
and conversion to contract arguments. See `scripts/v2/benchmark_testnet_v2.js`.

## Provenance and sanitization

`manifest.json` records the published files' hashes, source provenance and any
transformations. Numerical observations, order and warm-up flags within the
published campaigns are preserved. Model API `responseId` values are removed.
WAN connection settings, account paths and endpoint identifiers are omitted or
replaced with placeholders; these substitutions are not timing observations.
Public transaction hashes and contract addresses are retained for chain-level
inspection. Private keys, API credentials, SSH credentials and private environment
files are not distributed. A source hash describes the original file; it does not
claim that a sanitized publication copy is byte-identical to that source.

The batching simulation uses the supplied seeded algorithm rather than a
separately collected external input dataset. Experiment drivers generate model
prompts and controlled protocol inputs. Live reruns require the resources in
`docs/EXTERNAL_EXPERIMENTS.md`; their measurements depend on the new environment.
