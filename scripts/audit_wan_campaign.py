#!/usr/bin/env python3
"""Recalculate the retained full-batch3 WAN campaign from calls and timers."""
from collections import Counter
import json
from pathlib import Path


def audit_wan_campaign(directory, stats, equal):
    root = Path(directory)
    load = lambda name: json.loads((root / name).read_text(encoding='utf-8'))
    rows = lambda name: [json.loads(line) for line in (root / name).read_text(encoding='utf-8').splitlines() if line.strip()]
    raw = rows('all-raw.jsonl')
    assert len(raw) == 2640 and sum(not r['warmup'] for r in raw) == 2400
    assert all(r['recordType'] == 'wan_protocol_sample' and r['outcome'] == 'success' for r in raw)
    assert len({r['campaignId'] for r in raw}) == 1, 'Do not mix WAN campaigns'
    expected_ids = {f'r{r}-{mode}-c{c}' for r in (1, 2, 3) for mode in ('local', 'remote') for c in (1, 4, 8, 16)}
    saved = load('summary.json')
    assert len(saved) == 24 and {s['id'] for s in saved} == expected_ids
    windows = load('complete-measurement-windows.json')
    assert len(windows) == 24 and {w['run'] for w in windows} == expected_ids
    assert all(w['campaignFolder'] == 'wan-full-batch3' for w in windows)
    verified, run_windows, all_individual = 0, [], []
    for name in sorted(expected_ids):
        setting = load(name + '-summary.json')
        aggregate = next(s for s in saved if s['id'] == name)
        assert setting['metrics'] == aggregate['metrics'] and setting['originalReport'] == aggregate['originalReport']
        individual = rows(name + '-raw.jsonl')
        all_individual.extend(individual)
        selected = [r for r in raw if r['diagnosticRun'] == name]
        assert Counter(json.dumps(r, sort_keys=True) for r in individual) == Counter(json.dumps(r, sort_keys=True) for r in selected)
        measured = [r for r in selected if not r['warmup']]
        assert len(selected) == 110 and len(measured) == 100
        assert all(r['round'] == setting['round'] and r['transportMode'] == setting['mode']
                   and r['concurrency'] == setting['concurrency'] for r in selected)
        assert len({r['iteration'] for r in selected}) == 110
        for metric, expected in setting['metrics'].items():
            actual = stats([r[metric] for r in measured])
            for key, value in actual.items():
                equal(value, expected[key], name + '/' + metric + '/' + key)
            verified += 1
        window = next(w['originalReport'] for w in windows if w['run'] == name)
        assert window == setting['originalReport']
        assert window['campaignId'] == measured[0]['campaignId']
        assert window['transportMode'] == setting['mode'] and window['concurrency'] == setting['concurrency']
        assert window['measuredSamples'] == 100
        assert window['firstMeasuredIteration'] == min(r['iteration'] for r in measured)
        assert window['lastMeasuredIteration'] == max(r['iteration'] for r in measured)
        assert window['measuredElapsedMs'] > 0
        goodput = len(measured) * 1000 / window['measuredElapsedMs']
        equal(goodput, window['throughputOpsPerSecond'], name + '/goodput')
        run_windows.append({'run': name, 'placement': setting['mode'], 'concurrency': setting['concurrency'],
                            'completedCalls': len(measured), 'measuredElapsedMs': window['measuredElapsedMs'],
                            'goodput': goodput})
    assert Counter(json.dumps(r, sort_keys=True) for r in all_individual) == Counter(json.dumps(r, sort_keys=True) for r in raw)
    figures = []
    for mode in ('local', 'remote'):
        for concurrency in (1, 4, 8, 16):
            samples = [r for r in raw if not r['warmup'] and r['transportMode'] == mode and r['concurrency'] == concurrency]
            selected_windows = [w for w in run_windows if w['placement'] == mode and w['concurrency'] == concurrency]
            assert len(samples) == 300 and len(selected_windows) == 3
            latency = stats([r['totalMs'] for r in samples])
            elapsed = sum(w['measuredElapsedMs'] for w in selected_windows)
            figures.append({'placement': mode, 'concurrency': concurrency, 'measuredCalls': 300,
                            'runs': 3, 'meanMs': latency['mean'], 'p95Ms': latency['p95'],
                            'goodput': len(samples) * 1000 / elapsed, 'combinedMeasuredElapsedMs': elapsed})
    return {'sampleCounts': {'total': len(raw), 'measured': 2400, 'warmups': 240},
            'recalculatedSummaryRows': verified, 'windows': run_windows, 'figure3': figures,
            'goodputDefinition': '300 completed calls divided by the sum of the three original complete measurement windows, for each placement/concurrency; warm-ups excluded.'}
