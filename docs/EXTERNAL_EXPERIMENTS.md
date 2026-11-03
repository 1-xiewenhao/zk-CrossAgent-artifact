# External experiments

Run commands from the repository root after following the README. The default
configurations preserve the manuscript's workloads. Edit a copy named
`*.local.json` to specify your own deployment; these files are ignored by Git.
Do not commit credentials or generated results.

## Two-host WAN

Provision two Linux hosts in different geographical regions. The coordinator runs
the protocol and cryptographic adapter; the remote process computes response bytes.
The adapter holds the provider signing key and delivery key at the coordinator.
This deployment does not model a malicious, independently key-holding provider
adapter. Confirmation-gated delivery is measured separately from later on-chain
batch confirmation.

Install Node.js 20.20.1 and the repository on both hosts; `npm ci` is needed on the
coordinator. The remote provider uses Node.js built-ins only. On the provider:

```sh
node scripts/wan/cache-host.js
chmod +x scripts/wan/wan-node
```

The coordinator runner also caches its host metadata before the measured command.
This corresponds to the reported measurement procedure: repeated enumeration of
the host's CPUs is excluded from restart-handshake timing. The launcher does not
pin CPU cores or impose an artificial concurrency cap. The cache contains actual
metadata from the current host and must be regenerated when the host changes.

Set up key-based SSH authentication and verify the provider's SSH host key through
your normal administration channel. Supply local paths in `.env`:

```text
WAN_SSH_KEY_PATH=/absolute/path/to/your/ssh_private_key
WAN_KNOWN_HOSTS_PATH=/absolute/path/to/your/verified_known_hosts
ALLOW_REAL_WAN_EXPERIMENT=1
```

Copy `submission-wan-20261015.json` to
`experiments/v2/configs/wan.local.json`. Set the two region labels, hostname, SSH
port, user, absolute provider-script path, and absolute `scripts/wan/wan-node` path.
Use remote paths without spaces; the SSH command transports these as arguments.
Verify that `node` is available in the remote user's noninteractive `PATH`.

### WAN performance used in Figure 3

Run the complete performance campaign with your deployment configuration:

```sh
npm run repro:wan-paper -- experiments/v2/configs/wan.local.json
# Optional: choose a new result directory.
npm run repro:wan-paper -- experiments/v2/configs/wan.local.json experiments/v2/results/my-wan-paper
```

The campaign runs three complete repetitions of both placements (same host and
cross region) at concurrency 1, 4, 8, and 16. Each setting retains 100 calls after
10 warm-ups in each repetition: 2,400 measured calls, 240 warm-ups, and 24 complete
measurement windows in total. All measured calls from the three repetitions
contribute to the reported latency distribution. Goodput is total completed calls
divided by the sum of the three complete windows for each placement/concurrency
setting. It is not the arithmetic mean of the three goodputs or the inverse of
mean latency. Preserve the window reports alongside the per-call records.

Replace deployment-specific fields rather than changing the workload to reproduce
the manuscript configuration. Keep each complete campaign's records and provenance
together; use a distinct output directory for each new campaign. Do not substitute
the original password/askpass startup for the documented key-based SSH setup.

### Separate provider-recovery experiment

The provider-recovery experiment is independent of Figure 3. The existing WAN
driver includes transport measurements and 20 retained provider-recovery rounds
after two warm-ups, controlled by the `recovery` block in the configuration:

```sh
npm run repro:wan -- experiments/v2/configs/wan.local.json
```

This legacy combined driver also writes its own protocol sweep; those results are
not the three-run Figure 3 campaign. Use its provider-recovery records for
Section VI-E(b), keeping them separate from the performance campaign. The
published archive includes only the provider-recovery records used by that section,
not the obsolete protocol sweep. Recovery includes session establishment,
authentication, and restarting the remote provider process; the coordinator's
receipt-signing and delivery-key functions remain available.

## Model-service requests

Set `DEEPSEEK_API_KEY` and `ALLOW_PAID_LLM_EXPERIMENT=1` in `.env`, then run:

```sh
npm run repro:llm
```

The configuration records the requested `deepseek-flash` model, disabled thinking,
temperature, output-token limit, prompt, and warm-up/measured sample counts.
The API model name is retained as used in the study; service availability is an
external dependency. If the provider retires or changes it, use a separate local
configuration and identify the change when reporting the rerun. The driver records
the returned model identifier and request metadata. No model weights are distributed.

The measured request includes the remote service and network request, rather than
isolated GPU inference. API usage is charged to the reviewer's account.

## Public test networks

Use Polygon Amoy (chain ID 80002) and Ethereum Sepolia (11155111), with the
confirmation depths in `submission-testnet-20261015.json`. Use RPC endpoints that
support the configured network and the transactions generated by ethers 5.8.0.

Create dedicated testnet accounts and fill `.env`:

| Variable | Role |
| --- | --- |
| `POLYGON_RPC_URL`, `SEPOLIA_RPC_URL` | Your RPC endpoints |
| `GATEWAY_PRIVATE_KEY` | Contract deployer/provider; fund on both networks |
| `ENDPOINT_PRIVATE_KEY` | Authorized relay endpoint; fund on Sepolia |
| `TRUSTED_ISSUER_PRIVATE_KEY` | Payer/issuer; fund on Sepolia for escrow deposits and fees |
| `BUYER_PRIVATE_KEY` | Buyer identity used in receipts |
| `GATEWAY_RELEASE_PRIVATE_KEY` | Unused-budget release signer |
| `GATEWAY_RELEASE_AUTHORITY` | Address corresponding to the release signer |

Obtain sufficient test tokens from the networks' faucets. Required balances vary
with current fees. Keys and private RPC URLs are never part of the released files.

After bootstrap, compile and commit the newly generated verifier as described in
the README, then inspect the deployment plan:

```sh
npm run repro:testnet-plan
```

The plan queries the networks but does not broadcast transactions. Check the
addresses, available balances, and chain IDs. Set `ALLOW_TESTNET_DEPLOYMENT=1`
locally to deploy:

```sh
npm run repro:testnet-deploy
```

Set `ALLOW_TESTNET_BENCHMARK=1` to run settlement/confirmation measurements and
unused-budget withdrawal checks:

```sh
npm run repro:testnet
```

Deployment and benchmark manifests are generated under the selected campaign's
result directory. Do not discard a partial deployment and blindly redeploy with
the same predicted addresses. A failed RPC call or insufficient balance needs
inspection before resuming. The published driver covers a fresh deployment;
the authors' account-specific recovery helpers are not part of this release.

The benchmark sends actual testnet transactions and waits for confirmations.
Chain upgrades, congestion, RPC limits, and service availability can change timing
or require transport adjustments; record such adjustments when reporting results.
