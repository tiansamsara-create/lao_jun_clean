const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Run the actual core module, including its closed-over scanRule, with a fully
// virtual filesystem and empty environment. No user path is accessed and no
// exported-function replacement is used as a scanRule stub.
function fixture(count, { cancelAfterProgress = Infinity } = {}) {
  const rules = Array.from({ length: count }, (_, index) => ({
    id: `rule-${index}`, app: `app-${index}`,
    patterns: [path.resolve('virtual-progress-fixture', `rule-${index}`)]
  }));
  const jobs = rules.map(() => ({ started: deferred(), release: deferred(), wasStarted: false }));
  const progress = [], milestones = rules.map(() => deferred());
  const cancelToken = { cancelled: false };
  let active = 0, peak = 0;
  const indexFor = (target) => {
    const index = rules.findIndex((rule) => rule.patterns[0] === target);
    assert.ok(index >= 0, `unexpected virtual path: ${target}`);
    return index;
  };
  const promises = {
    async access(target) { indexFor(target); },
    async lstat(target) {
      const index = indexFor(target);
      jobs[index].wasStarted = true;
      active++;
      peak = Math.max(peak, active);
      jobs[index].started.resolve();
      try {
        await jobs[index].release.promise;
        return { isSymbolicLink: () => false, isFile: () => true, size: index + 1 };
      } finally { active--; }
    },
    async readdir() { throw new Error('unexpected directory traversal'); }
  };
  const dependencies = {
    'node:fs': { promises },
    'node:path': path,
    'node:os': {},
    'node:crypto': require('node:crypto'),
    './rules': { staticRules: rules, expandEnvironment: (value) => value },
    './delete-engine': { deleteContents() { throw new Error('deletion forbidden'); } }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/core.js'), 'utf8'), {
    module, process: { env: {} },
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`);
      return dependencies[name];
    }
  });
  const running = module.exports.scanAll({
    cancelToken,
    onProgress(value) {
      progress.push({ ...value });
      if (progress.length >= cancelAfterProgress) cancelToken.cancelled = true;
      milestones[progress.length - 1].resolve();
    }
  });
  return { jobs, progress, milestones, cancelToken, running,
    get active() { return active; }, get peak() { return peak; } };
}

test('scan progress counts completions monotonically while results retain rule order', async () => {
  const f = fixture(6);
  await Promise.all(f.jobs.slice(0, 4).map((job) => job.started.promise));
  assert.equal(f.active, 4);
  assert.equal(f.progress.length, 0);

  // Highest initial index finishes first; the slow first rule stays in flight.
  for (const [completed, index] of [3, 2, 1, 5, 4].entries()) {
    f.jobs[index].release.resolve();
    await f.milestones[completed].promise;
    if (completed < 2) await f.jobs[completed + 4].started.promise;
    assert.equal(f.progress[completed].current, completed + 1);
    assert.equal(f.progress[completed].total, 6);
    assert.ok(f.progress[completed].current < 6);
  }
  assert.equal(f.active, 1);
  assert.deepEqual(f.progress.map((value) => value.app), ['app-3', 'app-2', 'app-1', 'app-5', 'app-4']);
  f.jobs[0].release.resolve();
  const results = await f.running;
  assert.deepEqual(f.progress.map((value) => value.current), [1, 2, 3, 4, 5, 6]);
  assert.equal(f.progress[5].current, f.progress[5].total);
  assert.deepEqual(Array.from(results, (value) => value.id), Array.from({ length: 6 }, (_, i) => `rule-${i}`));
  assert.deepEqual(Array.from(results, (value) => value.bytes), [1, 2, 3, 4, 5, 6]);
  assert.equal(f.peak, 4);
  assert.equal(f.active, 0);
});

test('cancelled measurements do not count as complete or emit late progress', async () => {
  const f = fixture(6);
  await Promise.all(f.jobs.slice(0, 4).map((job) => job.started.promise));
  f.jobs[2].release.resolve();
  await f.milestones[0].promise;
  await f.jobs[4].started.promise;
  assert.equal(f.progress[0].current, 1);
  f.cancelToken.cancelled = true;
  // All these operations started before cancellation but return after it.
  for (const index of [4, 3, 1, 0]) f.jobs[index].release.resolve();
  const results = await f.running;
  assert.deepEqual(f.progress.map((value) => value.current), [1]);
  assert.deepEqual(Array.from(results, (value) => value.id), ['rule-2']);
  assert.equal(f.active, 0);
  assert.equal(f.peak, 4);
  // The sixth rule must never start after cancellation.
  assert.equal(f.jobs[5].wasStarted, false);
});

test('cancellation from progress callback prevents further reports and new rules', async () => {
  const f = fixture(6, { cancelAfterProgress: 1 });
  await Promise.all(f.jobs.slice(0, 4).map((job) => job.started.promise));
  f.jobs[3].release.resolve();
  await f.milestones[0].promise;
  assert.equal(f.cancelToken.cancelled, true);
  for (const index of [2, 1, 0]) f.jobs[index].release.resolve();
  const results = await f.running;
  assert.deepEqual(Array.from(results, (value) => value.id), ['rule-3']);
  assert.deepEqual(f.progress.map((value) => value.current), [1]);
  assert.equal(f.jobs[4].wasStarted, false);
  assert.equal(f.jobs[5].wasStarted, false);
  assert.equal(f.active, 0);
});
