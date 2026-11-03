#!/usr/bin/env python3
"""Recount the archived task-workflow JSONL evidence, without executing tests.

The runner's cryptographic, local-EVM, restart, and repeat-call observations
are retained evidence. This audit checks their cross-file consistency; it does
not rerun those operations or establish implementation-wide correctness.
"""
import argparse
from collections import Counter, defaultdict
import gzip
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile


def verify_durable_state(root, tasks, calls):
    """Inspect an extracted read-only copy; never write to the archived database."""
    with tempfile.TemporaryDirectory(prefix='zk-crossagent-audit-') as temporary:
        extracted = Path(temporary) / 'protocol.sqlite'
        compressed = root / 'protocol.sqlite.gz'
        if compressed.exists():
            with gzip.open(compressed, 'rb') as source, extracted.open('wb') as destination:
                shutil.copyfileobj(source, destination)
        else:
            shutil.copyfile(root / 'protocol.sqlite', extracted)
        db = sqlite3.connect(extracted.as_uri() + '?mode=ro&immutable=1', uri=True)
        db.row_factory = sqlite3.Row
        try:
            assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            for table, count in [('roots', len(tasks)), ('calls', len(calls)),
                                 ('consumed_child_nonces', len(calls)), ('batches', len(tasks))]:
                assert db.execute('SELECT COUNT(*) FROM ' + table).fetchone()[0] == count
            for task in tasks:
                row = db.execute('SELECT * FROM roots WHERE root_commitment = ?',
                                 (task['root']['capabilityCommitment'],)).fetchone()
                assert row['reserved_amount'] == '0' and row['reserved_calls'] == 0
                assert row['settled_amount'] == str(task['settledAmount']) and row['settled_calls'] == 3
            settled, retained_nonces = 0, 0
            for call in calls:
                call_id = call['reservation']['callId']
                transitions = db.execute("SELECT COUNT(*) FROM call_transitions WHERE call_id = ? AND to_state = 'SETTLED'",
                                         (call_id,)).fetchone()[0]
                if call['finalState'] == 'SETTLED':
                    assert transitions == 1
                    settled += 1
                else:
                    assert call['finalState'] == 'EXPIRED' and transitions == 0
                    nonce = db.execute('SELECT call_id FROM consumed_child_nonces WHERE child_issuer = ? AND child_nonce = ?',
                                       (call['child']['issuer'].lower(), str(call['child']['nonce']))).fetchone()
                    assert nonce[0] == call_id.lower()
                    retained_nonces += 1
            assert settled == 1800 and retained_nonces == 200
            return {'integrityCheck': 'ok', 'rootsChecked': len(tasks), 'callsChecked': len(calls),
                    'singleSettledTransitions': settled, 'expiredCallsWithRetainedNonces': retained_nonces}
        finally:
            db.close()


def audit_task_workflow(directory):
    root = Path(directory)
    load = lambda name: json.loads((root / name).read_text(encoding='utf-8'))
    rows = lambda name: [json.loads(line) for line in (root / name).read_text(encoding='utf-8').splitlines() if line.strip()]
    manifest, status = load('manifest.json'), load('status.json')
    assert status['state'] == 'complete'
    tasks, calls, traces, settlements, rejects, batches = [rows(name + '.jsonl') for name in
        ('tasks', 'calls', 'accounting-trace', 'settlements', 'rejections', 'batch-acceptance')]
    by_task = {t['taskLabel']: t for t in tasks}
    assert len(by_task) == len(tasks) == 600
    assert len(manifest['scenarios']) == 6 and manifest['taskCountPerScenario'] == 100
    assert len({t['root']['taskId'] for t in tasks}) == 600
    assert len({t['root']['capabilityCommitment'] for t in tasks}) == 600
    assert len(calls) == 2000 and len(settlements) == 1800 and len(traces) == 8700
    assert len(batches) == len({b['taskLabel'] for b in batches}) == 600
    assert all(b['status'] == 1 and b['realCount'] == 3 and b['trustedEndpointFixture'] for b in batches)

    def grouped(source):
        result = defaultdict(list)
        for row in source:
            assert row['taskLabel'] in by_task
            result[row['taskLabel']].append(row)
        return result

    call_groups, trace_groups, settlement_groups, reject_groups = map(grouped, (calls, traces, settlements, rejects))
    scenarios, concurrent_groups = {}, []
    state_keys = ('reservedAmount', 'reservedCalls', 'settledAmount', 'settledCalls')
    state = lambda row: tuple(int(row[k]) for k in state_keys)
    for name, task in by_task.items():
        cc, tt, ss, rr = [g[name] for g in (call_groups, trace_groups, settlement_groups, reject_groups)]
        success = [c for c in cc if c['finalState'] == 'SETTLED']
        failure = [c for c in cc if c['finalState'] == 'EXPIRED']
        assert task['outcome'] == 'pass'
        assert len(success) == task['acceptedCalls'] == 3
        assert len(cc) == task['historicalAdmittedCalls'] == len(success) + len(failure)
        assert len(failure) == task['failedReservations'] == int(task['scenario'] in ('failure_replacement', 'integrated_workflow'))
        counts = {
            'budgetRejects': sum(r.get('result', {}).get('error') == 'root budget exceeded' for r in rr),
            'countRejects': sum(r.get('result', {}).get('error') == 'root call limit exceeded' for r in rr),
            'nonceRejects': sum(r.get('error') == 'child nonce already consumed' for r in rr),
        }
        assert all(task[key] == value for key, value in counts.items())
        amount = sum(c['service']['providerAmount'] + c['service']['fee'] for c in success)
        assert amount == task['settledAmount']
        assert len({c['reservation']['callId'] for c in cc}) == len(cc)
        assert len({c['child']['nonce'] for c in cc}) == len(cc)
        dependencies = sum(c['request']['inputHash'] in {x['outputHash'] for x in success if x is not c} for c in success)
        assert dependencies == task['dependencyEdges'] == 2
        assert len(ss) == len({s['txHash'] for s in ss}) == 3
        assert {s['callId'] for s in ss} == {c['reservation']['callId'] for c in success}
        assert all(s['status'] == 1 and int(s['gasUsed']) > 0 and 'already settled' in s['duplicateRejection'] for s in ss)
        for settlement in ss:
            events = [e for e in settlement['events'] if e['event'] == 'ReceiptSettledV2']
            assert len(events) == 1 and events[0]['args'][0].lower() == settlement['callId'].lower()
        assert task['duplicateLocalReconciliations'] == task['duplicateSettlementRejected'] == 3
        assert task['postSettlementRejected'] is True

        for trace in tt:
            reserved, reserved_calls, settled, settled_calls = state(trace)
            assert min(reserved, reserved_calls, settled, settled_calls) >= 0
            assert reserved + settled <= task['budget'] and reserved_calls + settled_calls <= task['maxSubcalls']
            assert int(trace['budget']) == task['budget'] and trace['maxSubcalls'] == task['maxSubcalls']
        assert [t['atMs'] for t in tt] == sorted(t['atMs'] for t in tt)
        before = next(t for t in tt if t['event'] == 'workflow_delivered_before_settlement')
        assert state(before) == (amount, 3, 0, 0)
        for j, settlement in enumerate(ss):
            confirmed = next(t for t in tt if t['event'] == 'destination_confirmed:' + str(j))
            reconciled = next(t for t in tt if t['event'] == 'settlement_reconciled:' + str(j))
            call = next(c for c in success if c['reservation']['callId'] == settlement['callId'])
            charge = call['service']['providerAmount'] + call['service']['fee']
            assert confirmed['atMs'] < reconciled['atMs']
            a, b, c, d = state(confirmed)
            assert state(reconciled) == (a - charge, b - 1, c + charge, d + 1)
        final = task['final']
        assert final == {'reservedAmount': '0', 'reservedCalls': 0, 'settledAmount': str(amount),
                         'settledCalls': 3, 'budget': str(task['budget']), 'maxSubcalls': task['maxSubcalls']}
        assert task['destinationFinal']['settledAmount'] == str(amount) and task['destinationFinal']['settledCalls'] == 3
        after = next(t for t in tt if t['event'] == 'settlement_does_not_restore_allowance')
        assert state(after) == state(final) == state(tt[-1])
        assert amount == task['budget'] or task['maxSubcalls'] == 3

        if task['scenario'].endswith('contention') or task['scenario'] == 'integrated_workflow':
            contention_rejects = [r for r in rr if 'result' in r]
            assert len(contention_rejects) == 2
            error = 'root call limit exceeded' if task['scenario'] == 'count_contention' else 'root budget exceeded'
            assert all(r['result']['error'] == error for r in contention_rejects)
            competing_calls = [c for c in cc if c.get('concurrentResult')]
            assert len(competing_calls) == 2 and all(c['concurrentResult']['accepted'] for c in competing_calls)
            results = [c['concurrentResult'] for c in competing_calls] + [r['result'] for r in contention_rejects]
            assert len({r['worker'] for r in results}) == 4
            starts, ends = [r['startedMs'] for r in results], [r['endedMs'] for r in results]
            concurrent_groups.append({'taskLabel': name, 'startSpreadMs': max(starts) - min(starts),
                                      'allFourIntervalsOverlap': max(starts) < min(ends)})
        if failure:
            nonce_rejects = [r for r in rr if 'error' in r]
            assert len(nonce_rejects) == 1 and nonce_rejects[0]['error'] == 'child nonce already consumed'
            failed = failure[0]
            assert nonce_rejects[0]['proposal']['child']['nonce'] == failed['child']['nonce']
            assert nonce_rejects[0]['idempotentExpiredReplay'].lower() == failed['reservation']['callId'].lower()
            released = next(t for t in tt if t['event'] == 'failed_reservation_released')
            retained = next(t for t in tt if t['event'] == 'consumed_nonce_preserved')
            assert state(released) == state(retained)
        assert task['recoveredAfterRestart'] == int(task['scenario'] in ('settlement_recovery', 'integrated_workflow'))
        result = scenarios.setdefault(task['scenario'], Counter())
        result.update(tasks=1, passed=1)
        for key in ('acceptedCalls', 'historicalAdmittedCalls', 'dependencyEdges', 'budgetRejects', 'countRejects',
                    'nonceRejects', 'failedReservations', 'recoveredAfterRestart', 'duplicateLocalReconciliations',
                    'duplicateSettlementRejected'):
            result[key] += task[key]
    summary = load('summary.json')
    for scenario, values in scenarios.items():
        assert values['tasks'] == 100
        assert all(summary[scenario][key] == value for key, value in values.items())
    durable = verify_durable_state(root, tasks, calls)

    # Figure 4 shows the first integrated task, in event order (not elapsed time).
    chosen = trace_groups['integrated_workflow-1']
    events = [next(t['event'] for t in chosen if t['event'].startswith('key_released:')),
              'concurrent_reservations_complete', 'failed_reservation_released',
              'workflow_delivered_before_settlement', 'settlement_reconciled:0',
              'settlement_reconciled:1', 'settlement_reconciled:2', 'settlement_does_not_restore_allowance']
    figure4 = [dict(event=row['event'], **{key: int(row[key]) for key in state_keys}) for event in events
               for row in chosen if row['event'] == event]
    assert len(figure4) == 8
    return {'status': 'PASS', 'tasks': len(tasks), 'historicalCalls': len(calls),
            'confirmedSettlements': len(settlements), 'traceObservations': len(traces),
            'scenarioCounts': scenarios, 'postSettlementRejections': sum(t['postSettlementRejected'] for t in tasks),
            'concurrencyGroups': len(concurrent_groups),
            'groupsWithFourOverlappingIntervals': sum(g['allFourIntervalsOverlap'] for g in concurrent_groups),
            'figure4': figure4, 'durableState': durable,
            'auditBoundary': 'JSONL recount, cross-file consistency, and read-only SQLite inspection. Nonce retention, single SETTLED transitions, and recorded reconciliation snapshots are checked; process restart and callStatic outcomes remain original runner observations. No cryptographic verification, EVM execution, or new experiment is run.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run_directory', type=Path)
    args = parser.parse_args()
    print(json.dumps(audit_task_workflow(args.run_directory), indent=2))
