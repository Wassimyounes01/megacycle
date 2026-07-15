'use strict';
/*
 * cycles.cjs — generic example cycles for any codebase.
 *
 * A cycle is a self-contained improvement loop bound to a real signal:
 *   { id, title, domain, leverage, scan(ctx) -> { metrics, health, notes },
 *                                  predict(ctx, scan) -> [{ build, why, leverage, confidence }] }
 * scan() reads true on-disk state; predict() proposes concrete future builds. Both stay cheap and
 * $0 (file reads only). Swap these for your own, or add to them — megacycle loops over whatever it's given.
 *
 * `leverage` is a coarse priority tag (see LEVERAGE weights in megacycle.cjs); higher ranks first.
 */

// Count source files and how many have a sibling/parallel test.
function surveyCode(ctx) {
  const src = ctx.files(/\.(c?[jt]sx?|mjs)$/, { exclude: /(^|\/)(node_modules|dist|build|\.git|coverage)(\/|$)|\.(test|spec)\./ });
  const tests = ctx.files(/\.(test|spec)\.[cm]?[jt]sx?$/, { exclude: /(^|\/)(node_modules|dist|build|\.git)(\/|$)/ });
  const testedStems = new Set(tests.map(t => t.replace(/\.(test|spec)\.[cm]?[jt]sx?$/, '').replace(/^.*\//, '')));
  const untested = src.filter(f => !testedStems.has(f.replace(/\.[cm]?[jt]sx?$/, '').replace(/^.*\//, '')));
  return { src, tests, untested };
}

module.exports = [
  {
    id: 'test-coverage', title: 'Test coverage', domain: 'quality', leverage: 'quality',
    scan(ctx) {
      const { src, tests, untested } = surveyCode(ctx);
      const ratio = src.length ? +(1 - untested.length / src.length).toFixed(2) : 1;
      const health = !src.length ? 'green' : ratio >= 0.7 ? 'green' : ratio >= 0.3 ? 'amber' : 'red';
      return { metrics: { source_files: src.length, test_files: tests.length, untested: untested.length, coverage_ratio: ratio }, health, notes: untested.slice(0, 5).map(f => 'untested: ' + f) };
    },
    predict(ctx, scan) {
      if (scan.metrics.untested > 0) return [{ build: `add tests for the ${scan.metrics.untested} untested source files`, why: `coverage ratio is ${scan.metrics.coverage_ratio}`, leverage: 'quality', confidence: Math.min(0.9, 0.4 + scan.metrics.untested / 20) }];
      return [];
    },
  },
  {
    id: 'doc-freshness', title: 'Doc freshness', domain: 'docs', leverage: 'learning',
    scan(ctx) {
      const readme = ['README.md', 'README', 'readme.md'].find(p => ctx.exists(p));
      const ageDays = readme ? ctx.ageHours(readme) / 24 : Infinity;
      const health = !readme ? 'red' : ageDays <= 30 ? 'green' : ageDays <= 120 ? 'amber' : 'red';
      return { metrics: { has_readme: !!readme, readme_age_days: readme ? +ageDays.toFixed(0) : null, readme_lines: readme ? ctx.lines(readme) : 0 }, health, notes: readme ? [] : ['no README found'] };
    },
    predict(ctx, scan) {
      if (!scan.metrics.has_readme) return [{ build: 'write a README with a quickstart', why: 'no README present', leverage: 'learning', confidence: 0.85 }];
      if (scan.metrics.readme_lines < 20) return [{ build: 'expand the README (quickstart, examples, layout)', why: `README is only ${scan.metrics.readme_lines} lines`, leverage: 'learning', confidence: 0.6 }];
      if (scan.metrics.readme_age_days > 120) return [{ build: 'refresh the README to match current behavior', why: `README last touched ${scan.metrics.readme_age_days} days ago`, leverage: 'learning', confidence: 0.5 }];
      return [];
    },
  },
  {
    id: 'dependency-drift', title: 'Dependency drift', domain: 'infra', leverage: 'infra',
    scan(ctx) {
      const pkgRaw = ctx.read('package.json');
      let deps = 0, hasLock = ctx.exists('package-lock.json') || ctx.exists('pnpm-lock.yaml') || ctx.exists('yarn.lock');
      try { const p = JSON.parse(pkgRaw || '{}'); deps = Object.keys(p.dependencies || {}).length; } catch { /* no/invalid pkg */ }
      const health = !pkgRaw ? 'green' : (deps > 0 && !hasLock) ? 'amber' : 'green';
      return { metrics: { has_package_json: !!pkgRaw, dependencies: deps, has_lockfile: hasLock }, health, notes: (deps > 0 && !hasLock) ? ['dependencies without a lockfile'] : [] };
    },
    predict(ctx, scan) {
      if (scan.metrics.dependencies > 0 && !scan.metrics.has_lockfile) return [{ build: 'commit a lockfile for reproducible installs', why: `${scan.metrics.dependencies} deps, no lockfile`, leverage: 'infra', confidence: 0.7 }];
      return [];
    },
  },
  {
    id: 'todo-debt', title: 'TODO / FIXME debt', domain: 'integrity', leverage: 'integrity',
    scan(ctx) {
      const hits = ctx.grep(/\b(TODO|FIXME|XXX|HACK)\b/, /\.(c?[jt]sx?|mjs|py|go|rs|md)$/, { exclude: /(^|\/)(node_modules|dist|build|\.git)(\/|$)/, cap: 500 });
      const health = hits.length === 0 ? 'green' : hits.length <= 20 ? 'amber' : 'red';
      return { metrics: { markers: hits.length }, health, notes: hits.slice(0, 5) };
    },
    predict(ctx, scan) {
      if (scan.metrics.markers > 0) return [{ build: `resolve or ticket the ${scan.metrics.markers} TODO/FIXME markers`, why: 'open in-code debt', leverage: 'integrity', confidence: Math.min(0.8, 0.3 + scan.metrics.markers / 50) }];
      return [];
    },
  },
  {
    id: 'ci-presence', title: 'CI presence', domain: 'infra', leverage: 'infra',
    scan(ctx) {
      const ci = ctx.exists('.github/workflows') || ctx.exists('.gitlab-ci.yml') || ctx.exists('.circleci') || ctx.exists('azure-pipelines.yml');
      return { metrics: { has_ci: !!ci }, health: ci ? 'green' : 'amber', notes: ci ? [] : ['no CI config found'] };
    },
    predict(ctx, scan) {
      if (!scan.metrics.has_ci) return [{ build: 'add a CI workflow (lint + test on push)', why: 'no CI config present', leverage: 'infra', confidence: 0.65 }];
      return [];
    },
  },
];
