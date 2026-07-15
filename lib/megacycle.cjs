#!/usr/bin/env node
'use strict';
/*
 * megacycle.cjs — the super-loop.
 *
 * One ROUND: run every cycle's scan() in a bounded parallel pool, collect predictions, merge them
 * into a ranked/deduplicated backlog, and PROMOTE any prediction that recurs into a new standing
 * cycle (the registry grows itself). Loop --once, --rounds=N, or --loop on an --interval.
 *
 * $0 and local by default (file reads only). Pass your own cycles to runRound(), or an `enrich`
 * function to have any LLM add predictions. Every stage is fail-open — a broken cycle never crashes
 * the round.
 */
const fs = require('fs');
const path = require('path');

const safe = (fn, d) => { try { return fn(); } catch { return d; } };
const keyOf = b => String(b).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// Leverage weights — higher ranks first.
const LEVERAGE = { revenue: 5, 'token-efficiency': 5, 'self-improvement': 4, throughput: 4, quality: 3, learning: 3, integrity: 3, creative: 3, exploration: 2, 'self-model': 2, infra: 2 };
const levWeight = l => LEVERAGE[l] || 1;

function dataDir() { return process.env.MEGACYCLE_DATA_DIR ? path.resolve(process.env.MEGACYCLE_DATA_DIR) : path.join(__dirname, '..', 'data'); }
function ensureData() { const d = dataDir(); if (!fs.existsSync(d)) safe(() => fs.mkdirSync(d, { recursive: true })); return d; }

// ── ctx: cheap, defensive filesystem probes bound to a target dir (never throw) ────────────────
function makeCtx(baseDir) {
  const base = path.resolve(baseDir || '.');
  const abs = p => path.isAbsolute(p) ? p : path.join(base, p);
  const now = Date.now();
  const exists = p => safe(() => fs.existsSync(abs(p)), false);
  const ageHours = p => safe(() => (now - fs.statSync(abs(p)).mtimeMs) / 3.6e6, Infinity);
  const sizeKB = p => safe(() => fs.statSync(abs(p)).size / 1024, 0);
  const read = (p, n = 8000) => safe(() => fs.readFileSync(abs(p), 'utf8').slice(0, n), '');
  const lines = p => safe(() => fs.readFileSync(abs(p), 'utf8').split('\n').filter(Boolean).length, 0);
  const fresh = (p, amberH, redH) => { if (!exists(p)) return 'red'; const a = ageHours(p); return a <= amberH ? 'green' : a <= redH ? 'amber' : 'red'; };

  // Recursive file list (relative paths), matching `pattern`, honoring an `exclude` regex on the rel path.
  function files(pattern, { exclude, cap = 5000 } = {}) {
    const out = [];
    (function walk(dir) {
      if (out.length >= cap) return;
      const entries = safe(() => fs.readdirSync(dir, { withFileTypes: true }), []);
      for (const e of entries) {
        if (out.length >= cap) return;
        const full = path.join(dir, e.name);
        const rel = path.relative(base, full).split(path.sep).join('/');
        if (exclude && exclude.test(rel)) continue;
        if (e.isDirectory()) { if (e.name === 'node_modules' || e.name === '.git') continue; walk(full); }
        else if (pattern.test(rel)) out.push(rel);
      }
    })(base);
    return out;
  }

  // Grep across files matching `filePattern`; returns "path:line" matches, capped.
  function grep(re, filePattern, { exclude, cap = 500 } = {}) {
    const hits = [];
    for (const f of files(filePattern, { exclude })) {
      if (hits.length >= cap) break;
      const text = read(f, 200000);
      const ls = text.split('\n');
      for (let i = 0; i < ls.length; i++) { if (re.test(ls[i])) { hits.push(`${f}:${i + 1}`); if (hits.length >= cap) break; } }
    }
    return hits;
  }

  return { base, now, exists, ageHours, sizeKB, read, lines, fresh, files, grep, levWeight };
}

// ── bounded parallel pool ──────────────────────────────────────────────────────────────────────
async function pool(items, worker, limit) {
  const out = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx], idx); }
  });
  await Promise.all(runners);
  return out;
}

// ── backlog (dedup + seen-count) ────────────────────────────────────────────────────────────────
function backlogPath() { return path.join(dataDir(), 'backlog.jsonl'); }
function dynamicPath() { return path.join(dataDir(), 'dynamic-registry.json'); }

function loadBacklog() {
  const map = new Map();
  for (const line of safe(() => fs.readFileSync(backlogPath(), 'utf8').split('\n'), [])) {
    if (!line.trim()) continue;
    const e = safe(() => JSON.parse(line), null);
    if (e && e.key) map.set(e.key, e);
  }
  return map;
}
function saveBacklog(map) {
  ensureData();
  const body = [...map.values()].map(e => JSON.stringify(e)).join('\n') + (map.size ? '\n' : '');
  safe(() => { const tmp = backlogPath() + '.tmp'; fs.writeFileSync(tmp, body); fs.renameSync(tmp, backlogPath()); });
}
function loadDynamic() { return safe(() => JSON.parse(fs.readFileSync(dynamicPath(), 'utf8')), []); }
function saveDynamic(list) { ensureData(); safe(() => { const tmp = dynamicPath() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(list, null, 2)); fs.renameSync(tmp, dynamicPath()); }); }

function rankScore(e) { return levWeight(e.leverage) * (Number(e.confidence) || 0.5) * Math.log2(1 + (e.seen || 1)); }

// Turn a generic dynamic-registry entry into a runnable cycle (predicts its own build once, then decays).
function dynamicToCycle(d) {
  return {
    id: d.id, title: d.title || d.id, domain: d.domain || 'exploration', leverage: d.leverage || 'exploration', dynamic: true,
    scan: () => ({ metrics: { minted_from: d.build }, health: 'amber', notes: [d.build] }),
    predict: () => [{ build: d.build, why: 'promoted recurring prediction', leverage: d.leverage || 'exploration', confidence: 0.5 }],
  };
}

// ── one cycle's turn ─────────────────────────────────────────────────────────────────────────
async function runCycle(mc, ctx, enrich) {
  const scan = safe(() => mc.scan(ctx), { metrics: {}, health: 'amber', notes: ['scan failed'] });
  let preds = safe(() => mc.predict(ctx, scan), []) || [];
  if (typeof enrich === 'function') {
    try { const extra = await enrich(mc.domain, scan); if (extra) preds = preds.concat(Array.isArray(extra) ? extra : [{ build: String(extra), why: 'enricher', leverage: mc.leverage, confidence: 0.5 }]); } catch { /* fail-open */ }
  }
  return { id: mc.id, title: mc.title, domain: mc.domain, leverage: mc.leverage, dynamic: !!mc.dynamic, scan, predictions: preds };
}

/**
 * runRound(opts) — one full round.
 * opts: { dir, cycles, enrich, concurrency=6, promoteThreshold=3, mintCap=3 }
 * returns { results, backlog (ranked), minted, ms }
 */
async function runRound(opts = {}) {
  const started = Date.now();
  const ctx = makeCtx(opts.dir || process.env.MEGACYCLE_DIR || '.');
  const base = Array.isArray(opts.cycles) ? opts.cycles : require('./cycles.cjs');
  const dyn = loadDynamic().map(dynamicToCycle);
  const cycles = base.concat(dyn);
  const concurrency = Math.max(1, opts.concurrency || 6);
  const promoteThreshold = opts.promoteThreshold || 3;
  const mintCap = opts.mintCap || 3;

  const results = await pool(cycles, (mc) => runCycle(mc, ctx, opts.enrich), concurrency);

  // Merge predictions into the backlog.
  const map = loadBacklog();
  const knownIds = new Set(cycles.map(c => c.id));
  for (const r of results) {
    for (const p of r.predictions) {
      if (!p || !p.build) continue;
      const key = keyOf(p.build);
      const prev = map.get(key);
      map.set(key, { key, build: p.build, why: p.why || '', leverage: p.leverage || r.leverage, confidence: p.confidence != null ? p.confidence : 0.5, from: r.id, seen: (prev ? prev.seen : 0) + 1, last: new Date().toISOString() });
    }
  }

  // Promote recurring predictions into new dynamic cycles (bounded per round).
  const dynList = loadDynamic();
  const dynIds = new Set(dynList.map(d => d.id));
  let minted = 0;
  for (const e of [...map.values()].sort((a, b) => rankScore(b) - rankScore(a))) {
    if (minted >= mintCap) break;
    const id = 'dyn-' + e.key;
    if (e.seen >= promoteThreshold && !knownIds.has(id) && !dynIds.has(id)) {
      dynList.push({ id, title: e.build.slice(0, 60), build: e.build, domain: 'exploration', leverage: e.leverage, minted: new Date().toISOString() });
      dynIds.add(id); minted++;
    }
  }
  if (minted) saveDynamic(dynList);
  saveBacklog(map);

  const backlog = [...map.values()].sort((a, b) => rankScore(b) - rankScore(a));
  return { results, backlog, minted, ms: Date.now() - started };
}

module.exports = { runRound, makeCtx, rankScore, LEVERAGE, keyOf };

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const FLAG = n => args.includes(`--${n}`);
  const OPT = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : d; };
  const dir = OPT('dir', process.env.MEGACYCLE_DIR || '.');
  const rounds = FLAG('loop') ? Infinity : parseInt(OPT('rounds', '1'), 10);
  const interval = parseInt(OPT('interval', '900'), 10) * 1000;

  (async () => {
    for (let round = 1; round <= rounds; round++) {
      const r = await runRound({ dir });
      console.log(`\n[megacycle] round ${round === Infinity ? '' : round} · dir=${path.resolve(dir)} · ${r.ms}ms · minted ${r.minted}`);
      console.log('health:');
      for (const c of r.results) console.log(`  ${c.scan.health === 'green' ? '🟢' : c.scan.health === 'amber' ? '🟡' : '🔴'} ${c.title} — ${JSON.stringify(c.scan.metrics)}`);
      console.log('\ntop backlog:');
      r.backlog.slice(0, 8).forEach((e, i) => console.log(`  ${i + 1}. [${e.leverage} ·seen ${e.seen}] ${e.build}  (${e.why})`));
      if (round < rounds && Number.isFinite(interval)) await new Promise(res => setTimeout(res, interval));
    }
    process.stdout.write('', () => process.exit(0));
  })();
}
