# zk-CrossAgent

Companion artifact for **zk-CrossAgent: Task-Bounded Service Invocation
and Asynchronous Cross-Chain Settlement** (IEEE Transactions on Services Computing submission).

This repository contains the protocol implementation, smart contracts,
zero-knowledge circuit, formal models, automated tests, experiment drivers,
and the measurement campaigns used by the current manuscript. The archive
retains each campaign's acquisition time and provenance; its directory date
identifies the publication package, not a common experiment date.

The [dataset README](data/tsc-20261103/README.md) maps the archived records to
Sections V--VI, Tables I--V, and Figures 2--4. The WAN performance campaign
contains three complete runs, 300 measured calls per placement/concurrency
setting, and all 24 complete measurement-window durations. Its goodput can
therefore be recalculated independently. The separate 20-round WAN recovery
campaign and 600-task workflow campaign have their own records and scope.
A standard-library Python script recalculates the reported statistics without
connecting to external services. Independent benchmark runs create new
observations and do not guarantee identical timings.

To inspect the reported statistics without installing Node.js dependencies:

```sh
python scripts/recalculate_paper.py --output tmp/paper-statistics.json
```

## Contents

| Directory | Purpose |
| --- | --- |
| `lib/` | Authorization, committed delivery, persistent state, relaying, and unused-budget release |
| `contracts/v2/` | Capability and batch registries, receipt settlement, withdrawal, and Groth16 verification |
| `circuits/v2/` | Circom source; build products and proving parameters are generated locally |
| `formal/` | ProVerif authentication model and explicit state model |
| `test/` | Automated protocol, contract, recovery, and verifier tests |
| `scripts/v2/` | Local, model-service, public-testnet, and recovery experiments |
| `scripts/paper/` | Complete WAN performance and task-workflow campaigns |
| `experiments/v2/configs/` | Sample counts, workloads, and confirmation settings |
| `scripts/wan/` | Two-host launch support and metadata caching before timing |
| `data/tsc-20261103/` | Retained measurements, hashes, methodology and table/figure mapping |
| `scripts/recalculate_paper.py` | Offline statistical recalculation and consistency checks |

## Environment

The documented reproduction target is Linux x86-64 with Node.js **20.20.1** and
npm. Use `npm ci` to install the versions recorded in `package-lock.json`.
The measured coordinator used Linux 5.15 and an Intel Xeon Platinum 8470Q;
the reported host CPU count does not represent dedicated experimental cores.
A GPU and model weights are not required: the model-service experiment uses an API.

Additional tools are needed only for the corresponding workflows:

- Circom 2.2.0 or later on `PATH`, built from a pinned release; record `circom --version`.
  The circuit declares its required language version in its first line.
- ProVerif **2.05** installed in an opam switch. The formal runner invokes
  `opam exec -- proverif`.
- A C/C++ build toolchain and Python 3 if the platform needs to build `better-sqlite3`.
- OpenSSH and `ping` for the two-host WAN experiment.
- Optional Python 3 and matplotlib for plotting newly generated measurements.

Install dependencies from the repository root:

```sh
nvm install
nvm use
npm ci
cp .env.example .env
npm run repro:environment
```

Use the recorded dependency versions and campaign configurations when reproducing
the experiments. Document any local changes to the environment or workload.

## Start with local checks

```sh
npm run compile
npm run test:unit
npm run repro:state
```

`test:unit` runs the tests that do not require circuit build products or a generated
Groth16 proof. It excludes the batch-registry, deadline-settlement, and verifier
test files. It is a subset of `npm test`; excluded tests are not counted as passes.

For the symbolic verification:

```sh
opam install proverif.2.05
npm run repro:formal
```

The formal runner checks all queries and then runs the state model. Its output is
written under `formal/evidence/`, which is excluded from version control.

## Build the circuit and proof fixtures

Download the published Powers of Tau transcript to the following path, or set
`PTAU_PATH` to an existing copy:

```sh
mkdir -p circuits/v2/setup
curl --fail --location --retry 3 \
  https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_19.ptau \
  --output circuits/v2/setup/powersOfTau28_hez_final_19.ptau
npm run repro:bootstrap
npm test
npm run repro:circuit
```

The bootstrap compiles the circuit with `--O2`, verifies the published transcript
and its embedded BLAKE2b-512 digest, creates a fresh circuit-specific Groth16 setup,
exports the matching Solidity verifier, generates proof/test inputs, and compiles
the contracts. Setup and proving need substantial CPU, RAM, and temporary disk;
this is not a lightweight installation step. No fixed completion time or minimum
memory has been validated for arbitrary reviewer machines.

Fresh setup uses new randomness, so the generated keys, proofs, verifier constants,
and their hashes differ from the authors' setup. All must be generated together.
The circuit relation is unchanged. This prototype setup is not a production
multi-party ceremony.

The verifier is a tracked source file. Before deploying to a public test network,
commit the locally generated verifier so that the deployment's clean-worktree
check can record the actual version:

```sh
git add contracts/v2/generated/ZkCrossAgentBatchVerifierV2.sol
git commit -m "Record verifier generated for this reproduction"
```

Configure a local Git identity if needed. A downloaded ZIP can be used for local
tests; a Git checkout is recommended for deployment and version recording.

## Reproduce experiments

After bootstrap, run the full local workloads:

```sh
npm run repro:local
```

This runs protocol latency and concurrency, synthetic delay and payload sweeps,
batch-policy analysis, Groth16 proving, process-fault recovery, on-chain Gas
measurements on Hardhat, and matched Gas-policy calculations. Result files are
written under `experiments/v2/results/reproduction-local/` and
`experiments/v2/results/reproduction-fault-gas/`.

Run the separate task-workflow correctness campaign after installing dependencies
and compiling the contracts:

```sh
npm run compile
npm run repro:task-workflow
# Optional: choose a new output directory and the tasks per scenario.
npm run repro:task-workflow -- experiments/v2/results/my-task-workflow 100
```

The default is six scenarios with 100 tasks each. The runner exercises concurrent
admission, pre-commit failure, and interrupted reconciliation with the gateway's
durable SQLite state and a local EVM. Its test endpoint accepts batch roots
directly; this campaign requires no fresh Groth16 setup and does not measure
source-chain relaying or public-chain finality. The archive contains exported
records and accounting traces; see the dataset README for their scope.

See [the external experiment instructions](docs/EXTERNAL_EXPERIMENTS.md) for:

- the three-run geographical WAN performance campaign and separate provider recovery;
- the DeepSeek model-service request experiment;
- Polygon Amoy/Sepolia deployment, confirmation timing, settlement, and withdrawal.

Those experiments require the reviewer's own hosts, credentials, working RPC
services, and funded testnet accounts. No external experiment is enabled by default.
Synthetic local delay is not a replacement for a geographical WAN run.

Each benchmark writes raw samples and mean/percentile summaries. Warm-up handling
and sample counts are specified in the configuration and benchmark implementation.
Latency, throughput, remote-model response time, and public-chain confirmation
time depend on the environment. Independent reruns do not guarantee the exact
numbers reported in the manuscript. Failed or interrupted runs should be preserved
locally and identified as such, rather than merged silently into completed runs.

To plot newly generated local summaries, install matplotlib in your own Python
environment and run:

```sh
python scripts/plot_results.py --local experiments/v2/results/reproduction-local
```

The offline recalculation report exports the archived Figure 3 values from the
three complete WAN runs. Plots of newly generated measurements visualize that
run; they are not copies of the manuscript's figures.

## Scope of availability

This snapshot includes the code and measurement campaigns used by the current
manuscript. Superseded measurements and diagnostic trials are outside this
publication dataset. Source provenance is recorded in `docs/SOURCE_PROVENANCE.json`;
data provenance, transformations, and hashes are in `data/tsc-20261103/manifest.json`.
Secrets, private endpoint configuration and bulky regenerable build artifacts
are omitted. New benchmark results remain ignored by Git; the published archive
is kept in a separate read-only analysis location.

No open-source license has been assigned. The existing `UNLICENSED` designation
is retained; public visibility alone does not grant an open-source license.
