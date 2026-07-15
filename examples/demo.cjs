'use strict';
// demo.cjs — run three rounds against this repo and watch the backlog rank + the registry self-grow.
// Run: node examples/demo.cjs
const path = require('path');
const { runRound } = require('../lib/cadence.cjs');

// Scan the repo root (one level up from examples/), with a low promote threshold so growth is visible.
const dir = path.join(__dirname, '..');

(async () => {
  for (let round = 1; round <= 3; round++) {
    const r = await runRound({ dir, promoteThreshold: 2, mintCap: 2 });
    console.log(`\n=== round ${round} (${r.ms}ms, minted ${r.minted} dynamic cycles) ===`);
    for (const c of r.results) {
      const dot = c.scan.health === 'green' ? '🟢' : c.scan.health === 'amber' ? '🟡' : '🔴';
      console.log(`  ${dot} ${c.title}: ${JSON.stringify(c.scan.metrics)}`);
    }
    console.log('  top backlog:');
    r.backlog.slice(0, 5).forEach((e, i) => console.log(`    ${i + 1}. [${e.leverage} · seen ${e.seen}] ${e.build}`));
  }
})();
