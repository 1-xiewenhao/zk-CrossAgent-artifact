/* Controlled task-level implementation experiment. No public RPC or paid API.
 * node task_workflow_runner.cjs --project-root /root/JNCA --out NEW_DIRECTORY --tasks 100
 * Uses original gateway/state and original compiled local-EVM contract artifacts.
 * The trusted endpoint directly accepts a fixture batch root; this is not a new
 * Groth16, public consensus, model-quality, or WAN experiment.
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), assert = require("assert");
const {createRequire} = require("module");
const {fork} = require("child_process");
const now = () => Number(process.hrtime.bigint()) / 1e6;
const safe = value => JSON.parse(JSON.stringify(value, (_,v) => typeof v === "bigint" ? v.toString() : v));
const sha = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
function args() { const a={}; for(let i=2;i<process.argv.length;i+=2) { if(!process.argv[i+1]) throw Error("Missing option value"); a[process.argv[i].slice(2)]=process.argv[i+1]; } return a; }
const opts = args();
const isReservationWorker = opts["reservation-worker"] === "1";
const project = path.resolve(opts["project-root"]);
const req = createRequire(path.join(project,"package.json"));
const {ethers} = req("ethers");
const {buildPoseidon, poseidonContract} = req("circomlibjs");
const P = req(path.join(project,"lib/protocol-v2.js"));
const {PersistentProtocolState} = req(path.join(project,"lib/v2/persistent-state.js"));
const {SecureGatewayV2,decryptDelivery} = req(path.join(project,"lib/v2/secure-gateway.js"));
const {verifyCommittedDelivery} = req(path.join(project,"lib/v2/delivery-validation.js"));
const {summarize} = req(path.join(project,"lib/v2/experiment-utils.js"));
const hash = s => ethers.utils.keccak256(ethers.utils.toUtf8Bytes(s));
const wallet = s => new ethers.Wallet(hash("controlled-task-fixture:"+s));
const masterKey = Buffer.from(ethers.utils.arrayify(hash("controlled-task-fixture-master")));
const providers = [wallet("retrieve"),wallet("analyze"),wallet("compose")];
const services = [
  {name:"retrieve",providerAmount:4,fee:1,bytes:512,delayMs:2},
  {name:"analyze",providerAmount:8,fee:2,bytes:2048,delayMs:5},
  {name:"compose",providerAmount:13,fee:2,bytes:1024,delayMs:3},
];
function gateway(state,poseidon,domain,domainHash,clock,providerIndex) {
  return new SecureGatewayV2({state,poseidon,eip712Domain:domain,settlementDomainHash:domainHash,providerSigner:providers[providerIndex],masterKey,clock});
}

async function workerMain() {
  const poseidon = await buildPoseidon();
  process.send({type:"ready"});
  let prepared = null;
  process.on("message", message => {
    let state = prepared?.state;
    try {
      if(message.type === "prepare") {
        if(prepared) throw Error("Worker already has a prepared reservation");
        const job=message.job;
        state = new PersistentProtocolState(job.db,{clock:()=>job.clock});
        const g = gateway(state,poseidon,job.domain,job.domainHash,()=>job.clock,job.providerIndex);
        prepared={state,g,job};
        process.send({type:"armed"});
        return;
      }
      if(message.type!=="start"||!prepared)throw Error("Unexpected worker command");
      const {g,job}=prepared;
      const startedMs = now();
      let result;
      try { result = {accepted:true,reservation:safe(g.reserveAuthorizedCall(job.args))}; }
      catch(error) { result = {accepted:false,error:error.message}; }
      const endedMs = now();
      state.assertRootInvariant(job.args.root.capabilityCommitment);
      state.close(); state=null;prepared=null;
      process.send({type:"result",...result,startedMs,endedMs,worker:Number(opts.index)});
    } catch(error) { if(state?.db?.open)state.close();prepared=null;process.send({type:"error",error:error.stack}); }
  });
}

async function main() {
  const out = path.resolve(opts.out), n = Number(opts.tasks || 100);
  if(!Number.isInteger(n)||n<1||n>1000) throw Error("tasks must be 1..1000 per scenario");
  if(fs.existsSync(out)) throw Error("Output exists; never overwrite an experiment");
  fs.mkdirSync(out,{recursive:true});
  const write = (name,v) => fs.writeFileSync(path.join(out,name),JSON.stringify(safe(v),null,2)+"\n");
  const append = (name,v) => fs.appendFileSync(path.join(out,name),JSON.stringify(safe(v))+"\n");
  const scenarios = ["dependent_chain","budget_contention","count_contention","failure_replacement","settlement_recovery","integrated_workflow"];
  const sourceFiles = ["lib/protocol-v2.js","lib/v2/persistent-state.js","lib/v2/secure-gateway.js","lib/v2/delivery-validation.js","lib/v2/experiment-utils.js","contracts/v2/EscrowReceiptV2.sol","contracts/v2/RootCapabilityRegistryV2.sol","contracts/v2/BatchInboxV2.sol","artifacts/contracts/v2/EscrowReceiptV2.sol/EscrowReceiptV2.json"];
  const sourceHashes = Object.fromEntries(sourceFiles.map(f=>[f,sha(path.join(project,f))]));
  write("manifest.json",{schemaVersion:1,startedAt:new Date().toISOString(),taskCountPerScenario:n,scenarios,services,sourceHashes,runnerSha256:sha(__filename),runtime:{node:process.version,platform:process.platform,arch:process.arch},scope:"Controlled local services and local Hardhat EVM. Trusted endpoint accepts fixture batch root; no fresh Groth16 proof, public-chain consensus or model-quality evaluation. Recovery fixture closes and reopens SQLite/gateway at an interrupted-reconciliation boundary; the harness queries isSettled then invokes markSettled. No relayer-daemon crash or power-loss test.",concurrency:"Four separate Node child processes, each with its own SQLite connection; the coordinator waits until all are armed then broadcasts start over IPC. Shared database and trusted-gateway authority. Actual start/end timestamps are retained; start broadcasts are not simultaneous atomic machine instructions.",warmup:"No latency claim or latency comparison is predeclared. All task iterations are correctness observations; times are retained diagnostically."});
  // Isolated Hardhat config avoids reading project .env and cannot select public RPC.
  const hhConfig=path.join(out,"hardhat-local.config.cjs");
  fs.writeFileSync(hhConfig,`require(${JSON.stringify(path.join(project,"node_modules/@nomiclabs/hardhat-ethers"))});\nmodule.exports={defaultNetwork:"hardhat",networks:{hardhat:{chainId:31337}},solidity:"0.8.28",paths:{root:${JSON.stringify(project)},artifacts:${JSON.stringify(path.join(project,"artifacts"))},cache:${JSON.stringify(path.join(out,"hardhat-cache"))}}};\n`);
  process.env.HARDHAT_CONFIG=hhConfig;
  const hre=req("hardhat");
  assert.equal(hre.network.name,"hardhat");
  const signers=await hre.ethers.getSigners(), [deployer,endpoint,payer,buyer,orchestrator,sourceRegistry]=signers;
  const poseidon=await buildPoseidon();
  async function deployPoseidon(k) { const c=await new ethers.ContractFactory(poseidonContract.generateABI(k),poseidonContract.createCode(k),deployer).deploy(); await c.deployed(); return c; }
  const p2=await deployPoseidon(2),p6=await deployPoseidon(6);
  const chainId=(await hre.ethers.provider.getNetwork()).chainId;
  const predicted=ethers.utils.getContractAddress({from:deployer.address,nonce:await deployer.getTransactionCount()});
  const domainHash=P.settlementDomainHash({serviceChainId:80002,serviceRegistry:sourceRegistry.address,settlementChainId:chainId,settlementContract:predicted});
  const factory=await hre.ethers.getContractFactory("EscrowReceiptV2");
  const escrow=await factory.connect(deployer).deploy(domainHash,endpoint.address,80002,sourceRegistry.address,p2.address,p6.address,deployer.address);
  await escrow.deployed();
  const domain=P.eip712Domain(chainId,escrow.address);
  let clock=(await hre.ethers.provider.getBlock("latest")).timestamp;
  const dbPath=path.join(out,"protocol.sqlite");
  let state=new PersistentProtocolState(dbPath,{clock:()=>clock});
  let gateways=services.map((_,i)=>gateway(state,poseidon,domain,domainHash,()=>clock,i));
  const restart=()=>{state.checkpoint();state.close();state=new PersistentProtocolState(dbPath,{clock:()=>clock});gateways=services.map((_,i)=>gateway(state,poseidon,domain,domainHash,()=>clock,i));};
  const workers=[];
  for(let i=0;i<4;i++) {
    const w=fork(__filename,["--project-root",project,"--reservation-worker","1","--index",String(i)],{stdio:["ignore","inherit","inherit","ipc"]});
    await new Promise((resolve,reject)=>{w.once("message",m=>m.type==="ready"?resolve():reject(Error(JSON.stringify(m))));w.once("error",reject);}); workers.push(w);
  }
  let epoch=0, taskOrdinal=0;
  const totals=[];
  try {
    for(let iteration=1;iteration<=n;iteration++) {
      // Rotate scenario order to avoid always assigning one scenario the cold process.
      const order=scenarios.map((_,i)=>scenarios[(i+iteration-1)%scenarios.length]);
      for(const scenario of order) {
        taskOrdinal++; clock=(await hre.ethers.provider.getBlock("latest")).timestamp;
        const taskLabel=`${scenario}-${iteration}`, start=now(), traces=[],calls=[],accepted=[];
        const budget=scenario==="budget_contention"?25:scenario==="count_contention"?100:30;
        const maxSubcalls=scenario==="budget_contention"?10:3;
        const root={protocolVersion:P.PROTOCOL_VERSION,issuer:payer.address,payer:payer.address,buyer:buyer.address,taskId:hash(taskLabel),permissions:7,budget,expiry:clock+86400,maxSubcalls,nonce:taskOrdinal,scopeHash:hash("controlled-three-service-scope"),settlementDomainHash:domainHash,capabilityCommitment:"0"};
        root.capabilityCommitment=P.computeRootCapabilityCommitment(poseidon,root).toString();
        const rootSignature=await payer._signTypedData(domain,P.ROOT_CAPABILITY_TYPES,P.rootCapabilityTypedValue(root));
        gateways[0].registerRoot(root,rootSignature);
        await (await escrow.registerRootCapability(root,rootSignature)).wait();
        await (await escrow.connect(payer).depositFor(payer.address,{value:budget})).wait();
        const onlineStarted=now();
        let nonce=taskOrdinal*100;
        const counters=()=>{const r=state.getRoot(root.capabilityCommitment);return {reservedAmount:r.reservedAmount.toString(),reservedCalls:r.reservedCalls,settledAmount:r.settledAmount.toString(),settledCalls:r.settledCalls,budget:r.budget.toString(),maxSubcalls:r.maxSubcalls};};
        const check=(event)=>{state.assertRootInvariant(root.capabilityCommitment);const r=state.getRoot(root.capabilityCommitment);assert(r.reservedAmount>=0n&&r.settledAmount>=0n&&r.reservedCalls>=0&&r.settledCalls>=0);const row={taskLabel,event,atMs:now(),...counters()};traces.push(row);return row;};
        const makeCall=async(providerIndex,inputHash,customNonce)=>{
          const service=services[providerIndex];
          const child={protocolVersion:P.PROTOCOL_VERSION,issuer:root.issuer,buyer:root.buyer,provider:providers[providerIndex].address,parentCommitment:root.capabilityCommitment,taskId:root.taskId,permissions:3,budget:service.providerAmount,expiry:root.expiry-60,maxSubcalls:1,nonce:customNonce??++nonce,scopeHash:root.scopeHash,settlementDomainHash:domainHash,capabilityCommitment:"0"};
          child.capabilityCommitment=P.computeChildCapabilityCommitment(poseidon,child).toString();
          const childSignature=await buyer._signTypedData(domain,P.CHILD_CAPABILITY_TYPES,P.childCapabilityTypedValue(child));
          const request={operation:service.name,inputHash,taskLabel};
          const args={root,child,childSignature,request,providerAmount:service.providerAmount,orchestratorFee:service.fee,orchestrator:orchestrator.address};
          return {providerIndex,service,child,childSignature,request,args};
        };
        const reserve=call=>{const t=now();call.reservation=gateways[call.providerIndex].reserveAuthorizedCall(call.args);call.reserveMs=now()-t;assert.equal(call.reservation.idempotent,false);calls.push(call);check("reserved:"+call.child.nonce);return call;};
        const deliver=async(call)=>{
          assert.equal(state.getCall(call.reservation.callId).state,"RESERVED");
          const t=now();await new Promise(r=>setTimeout(r,call.service.delayMs));
          const body=JSON.stringify({taskLabel,service:call.service.name,inputHash:call.request.inputHash});
          const payload=Buffer.from(body.padEnd(call.service.bytes," "));
          const g=gateways[call.providerIndex];
          const committed=await g.commitEncryptedResponse(call.reservation.callId,payload);
          const confirmation=verifyCommittedDelivery({...committed,poseidon,domain,...call.args});
          const buyerSignature=await buyer._signTypedData(domain,P.CALLER_CONFIRMATION_TYPES,confirmation);
          const released=await g.confirmAndRelease(call.reservation.callId,buyerSignature);
          const plain=decryptDelivery(released);assert(plain.equals(payload));
          assert.equal(JSON.parse(plain.toString()).inputHash,call.request.inputHash);
          call.committed=committed;call.buyerSignature=buyerSignature;call.released=released;call.outputHash=ethers.utils.keccak256(plain);call.deliveryMs=now()-t;
          accepted.push(call);check("key_released:"+call.child.nonce);
          return call;
        };
        let budgetRejects=0,countRejects=0,nonceRejects=0,failedReservations=0,dependencyEdges=0;
        const abortAndCheckNonce=async(failed,inputHash)=>{
          // Explicit harness-injected pre-commit abort; not automatic failure detection.
          state.expireUnconfirmed(failed.reservation.callId,"injected pre-commit abort");failedReservations++;check("failed_reservation_released");
          const replay=gateways[failed.providerIndex].reserveAuthorizedCall(failed.args);assert.equal(replay.idempotent,true);assert.equal(replay.state,"EXPIRED");
          const altered=await makeCall(2,inputHash,failed.child.nonce);
          assert.throws(()=>gateways[2].reserveAuthorizedCall(altered.args),/child nonce already consumed/);nonceRejects++;
          append("rejections.jsonl",{taskLabel,proposal:altered.args,error:"child nonce already consumed",idempotentExpiredReplay:replay.callId});
          check("consumed_nonce_preserved");
        };
        const first=await deliver(reserve(await makeCall(0,hash("input:"+taskLabel))));
        if(scenario.endsWith("contention")||scenario==="integrated_workflow") {
          const contenders=await Promise.all(Array.from({length:4},()=>makeCall(1,first.outputHash)));
          let armed=0;
          const results=await Promise.all(contenders.map((call,i)=>new Promise((resolve,reject)=>{
            const w=workers[i];
            const onMessage=m=>{
              if(m.type==="armed") {armed++;if(armed===4){for(const worker of workers)worker.send({type:"start"});}}
              else if(m.type==="result"||m.type==="error") {w.off("message",onMessage);m.type==="error"?reject(Error(m.error)):resolve(m);}
            };
            w.on("message",onMessage);w.send({type:"prepare",job:{db:dbPath,clock,domain,domainHash,providerIndex:call.providerIndex,args:call.args}});
          })));
          assert.equal(results.filter(x=>x.accepted).length,2,"exactly two siblings fit the remaining allowance");
          for(let i=0;i<4;i++) {
            const call=contenders[i],res=results[i];call.concurrentResult=res;
            if(res.accepted){call.reservation=res.reservation;calls.push(call);}
            else {const expected=scenario==="count_contention"?"root call limit exceeded":"root budget exceeded";assert.equal(res.error,expected);if(scenario==="count_contention")countRejects++;else budgetRejects++;append("rejections.jsonl",{taskLabel,proposal:call.args,result:res});}
          }
          check("concurrent_reservations_complete");
          const admitted=contenders.filter(c=>c.reservation);
          if(scenario==="integrated_workflow") {
            await abortAndCheckNonce(admitted[0],first.outputHash);
            const second=await deliver(admitted[1]);dependencyEdges++;
            await deliver(reserve(await makeCall(2,second.outputHash)));dependencyEdges++;
          } else {
            for(const call of admitted){await deliver(call);dependencyEdges++;}
          }
        } else {
          if(scenario==="failure_replacement") {
            const failed=reserve(await makeCall(1,first.outputHash));
            await abortAndCheckNonce(failed,first.outputHash);
          }
          const second=await deliver(reserve(await makeCall(1,first.outputHash)));dependencyEdges++;
          const third=await deliver(reserve(await makeCall(2,second.outputHash)));dependencyEdges++;
          assert.equal(third.request.inputHash,second.outputHash);
        }
        assert.equal(accepted.length,3);const onlineFinished=now();check("workflow_delivered_before_settlement");
        const expectedAmount=accepted.reduce((a,c)=>a+c.service.providerAmount+c.service.fee,0);
        assert.equal(Number(counters().reservedAmount),expectedAmount);assert.equal(counters().settledCalls,0);
        const leaves=accepted.map(c=>P.computeRealLeaf(poseidon,c.committed.receipt.receiptCommitment));
        const tree=P.buildMerkleTree(poseidon,leaves);epoch++;
        state.sealBatch({epoch,batchRoot:tree.root,callIds:accepted.map(c=>c.reservation.callId),metadata:{taskLabel,fixtureTrustedEndpoint:true}});
        for(const call of accepted)state.markProved(call.reservation.callId);
        const batchTx=await escrow.connect(endpoint).acceptBatchRoot(epoch,accepted.length,tree.root.toString(),taskOrdinal,hash("fixture-source-proof:"+taskLabel));
        const batchReceipt=await batchTx.wait();
        append("batch-acceptance.jsonl",{taskLabel,epoch,realCount:accepted.length,batchRoot:tree.root.toString(),txHash:batchTx.hash,status:batchReceipt.status,blockNumber:batchReceipt.blockNumber,events:batchReceipt.events.filter(e=>e.event).map(e=>({event:e.event,args:safe(e.args)})),trustedEndpointFixture:true});
        const batchKey=await escrow.computeBatchKey(epoch,tree.root.toString());
        let recoveredAfterRestart=0,duplicateLocalReconciliations=0,duplicateSettlementRejected=0;
        for(let i=0;i<accepted.length;i++) {
          const call=accepted[i],callId=call.reservation.callId;
          state.markRootRelayed(callId);
          const settleArgs=[call.committed.receipt,call.committed.providerSignature,call.buyerSignature,call.released.keyReveal,batchKey,i,tree.proof(i).map(String)];
          const tx=await escrow.settleReceipt(...settleArgs);state.markSettling(callId,tx.hash);
          const receipt=await tx.wait();assert.equal(receipt.status,1);check("destination_confirmed:"+i);
          if(["settlement_recovery","integrated_workflow"].includes(scenario)&&i===2) {
            // Interrupted-reconciliation fixture: destination confirmed, local counters reserved.
            restart();assert.equal(state.getCall(callId).state,"SETTLING");assert.equal(counters().reservedCalls,1);
            assert.equal(await escrow.isSettled(callId),true);recoveredAfterRestart++;
          }
          assert.equal(await escrow.isSettled(callId),true);
          state.markSettled(callId);check("settlement_reconciled:"+i);
          const before=counters();const again=state.markSettled(callId);assert.equal(again.idempotent,true);assert.deepEqual(counters(),before);duplicateLocalReconciliations++;
          let rejection=null;try{await escrow.callStatic.settleReceipt(...settleArgs);}catch(error){rejection=error.reason||error.message;}
          assert(rejection&&/already settled/i.test(rejection),"duplicate receipt must be rejected by destination");duplicateSettlementRejected++;
          append("settlements.jsonl",{taskLabel,callId,batchKey,leafIndex:i,proof:tree.proof(i).map(String),txHash:tx.hash,status:receipt.status,gasUsed:receipt.gasUsed.toString(),blockNumber:receipt.blockNumber,events:receipt.events.filter(e=>e.event).map(e=>({event:e.event,args:safe(e.args)})),duplicateRejection:rejection});
        }
        const onchain=await escrow.getRootRecord(root.capabilityCommitment),final=counters();
        assert.equal(onchain.settledAmount.toString(),String(expectedAmount));assert.equal(Number(onchain.settledCalls),3);assert.equal(final.settledAmount,String(expectedAmount));assert.equal(final.settledCalls,3);assert.equal(final.reservedAmount,"0");assert.equal(final.reservedCalls,0);
        const extra=await makeCall(0,hash("post-settlement:"+taskLabel));let postError=null;
        try{gateways[0].reserveAuthorizedCall(extra.args);}catch(error){postError=error.message;}
        assert.equal(postError,scenario==="count_contention"?"root call limit exceeded":"root budget exceeded");
        assert.deepEqual(counters(),final);check("settlement_does_not_restore_allowance");
        for(const call of calls)append("calls.jsonl",{taskLabel,child:call.child,childSignature:call.childSignature,request:call.request,providerIndex:call.providerIndex,service:call.service,reservation:call.reservation,committed:call.committed,buyerSignature:call.buyerSignature,released:call.released,outputHash:call.outputHash,concurrentResult:call.concurrentResult,finalState:state.getCall(call.reservation.callId).state});
        for(const row of traces)append("accounting-trace.jsonl",row);
        const destinationFinal={settledAmount:onchain.settledAmount.toString(),settledCalls:Number(onchain.settledCalls),atBlock:await hre.ethers.provider.getBlockNumber(),contract:escrow.address};
        const result={taskLabel,scenario,iteration,outcome:"pass",budget,maxSubcalls,root,rootSignature,acceptedCalls:accepted.length,historicalAdmittedCalls:calls.length,dependencyEdges,budgetRejects,countRejects,nonceRejects,failedReservations,recoveredAfterRestart,duplicateLocalReconciliations,duplicateSettlementRejected,postSettlementRejected:true,settledAmount:expectedAmount,onlineDiagnosticMs:onlineFinished-onlineStarted,totalDiagnosticMs:now()-start,final,destinationFinal};
        append("tasks.jsonl",result);totals.push(result);
        write("status.json",{state:"running",completedTasks:totals.length,totalTasks:n*scenarios.length,lastTask:taskLabel,at:new Date().toISOString()});
        console.log(JSON.stringify({taskLabel,outcome:"pass",completed:totals.length,total:n*scenarios.length}));
      }
    }
    state.checkpoint();
    const summary=Object.fromEntries(scenarios.map(s=>{const rows=totals.filter(r=>r.scenario===s);const sums={};for(const key of ["acceptedCalls","historicalAdmittedCalls","dependencyEdges","budgetRejects","countRejects","nonceRejects","failedReservations","recoveredAfterRestart","duplicateLocalReconciliations","duplicateSettlementRejected"])sums[key]=rows.reduce((a,r)=>a+r[key],0);return [s,{tasks:rows.length,passed:rows.filter(r=>r.outcome==="pass").length,...sums,onlineDiagnosticMs:summarize(rows.map(r=>r.onlineDiagnosticMs)),totalDiagnosticMs:summarize(rows.map(r=>r.totalDiagnosticMs))}];}));
    write("summary.json",summary);write("status.json",{state:"complete",completedTasks:totals.length,totalTasks:n*scenarios.length,at:new Date().toISOString()});
    assert.deepEqual(Object.fromEntries(sourceFiles.map(f=>[f,sha(path.join(project,f))])),sourceHashes,"source/artifacts changed during experiment");
  } catch(error) {write("status.json",{state:"failed",completedTasks:totals.length,error:error.stack,at:new Date().toISOString()});throw error;}
  finally {if(state?.db?.open)state.close();await Promise.all(workers.map(w=>new Promise(resolve=>{w.once("exit",resolve);w.kill("SIGTERM");})));}
  const outputHashes=Object.fromEntries(fs.readdirSync(out).filter(f=>/\.(jsonl|json|sqlite)$/.test(f)).map(f=>[f,sha(path.join(out,f))]));write("output-sha256.json",outputHashes);
}
if(isReservationWorker)workerMain().catch(error=>{process.send({type:"error",error:error.stack});process.exitCode=1;});
else main().then(()=>process.exit(0)).catch(error=>{console.error(error.stack);process.exit(1);});
