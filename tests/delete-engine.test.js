const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const path = require('node:path');
const os = require('node:os');
const { deleteContents } = require('../src/delete-engine');
const report = () => ({ cleanedFiles: 0, cleanedBytes: 0, skippedFiles: 0, errors: [] });

test('parallel deletion preserves root and counts nested files exactly', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qingpan-parallel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let d = 0; d < 10; d++) {
    const dir = path.join(root, String(d));
    await fs.mkdir(dir);
    await Promise.all(Array.from({ length: 50 }, (_, i) => fs.writeFile(path.join(dir, String(i)), Buffer.alloc(100))));
  }
  const result = report();
  await deleteContents(root, result);
  assert.equal(result.cleanedFiles, 500);
  assert.equal(result.cleanedBytes, 50000);
  assert.deepEqual(await fs.readdir(root), []);
  assert.deepEqual(result.errors, []);
});

test('cancellation drains active work and preserves unstarted files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qingpan-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(path.join(root, String(i)), 'a')));
  const result = report();
  const cancelToken = {};
  await deleteContents(root, result, { cancelToken, onProgress: () => { if (result.cleanedFiles >= 10) cancelToken.cancelled = true; } });
  const count = result.cleanedFiles;
  assert.ok(count >= 10 && count < 100);
  assert.equal((await fs.readdir(root)).length, 100 - count);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(result.cleanedFiles, count);
});

test('junction targets are never traversed', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qingpan-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache');
  const outside = path.join(root, 'protected');
  await fs.mkdir(cache); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, path.join(cache, 'junction'), 'junction');
  await deleteContents(cache, report());
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

// Every path mutated by these tests belongs to a newly created fixture. Resolve
// the temp base so a platform's own temp alias does not trip the ancestor guard.
async function safetyFixture(t) {
  const base = await fs.realpath(os.tmpdir());
  const fixture = await fs.mkdtemp(path.join(base, 'qingpan-path-safety-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  return fixture;
}

function assertRejected(result) {
  assert.equal(result.cleanedFiles, 0);
  assert.equal(result.cleanedBytes, 0);
  assert.ok(result.skippedFiles > 0);
  assert.match(result.errors.join('\n'), /路径安全校验失败/);
}

test('rejects a junction at the cleanup root without touching its destination', async (t) => {
  const fixture = await safetyFixture(t);
  const outside = path.join(fixture, 'protected');
  const cache = path.join(fixture, 'cache');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'root sentinel');
  await fs.symlink(outside, cache, 'junction');
  const result = report();
  await deleteContents(cache, result);
  assertRejected(result);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'root sentinel');
  assert.equal((await fs.lstat(cache)).isSymbolicLink(), true);
});

test('rejects a junction in the root ancestor chain and preserves external sentinels', async (t) => {
  const fixture = await safetyFixture(t);
  const outside = path.join(fixture, 'protected');
  const destination = path.join(outside, 'nested', 'cache');
  const alias = path.join(fixture, 'app');
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'keep.txt'), 'ancestor sentinel');
  await fs.symlink(outside, alias, 'junction');
  const result = report();
  await deleteContents(path.join(alias, 'nested', 'cache'), result);
  assertRejected(result);
  assert.match(result.errors.join('\n'), /junction/);
  assert.equal(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8'), 'ancestor sentinel');
  assert.equal((await fs.lstat(alias)).isSymbolicLink(), true);
});

test('ordinary deep directories are cleaned with exact byte counts and root preserved', async (t) => {
  const fixture = await safetyFixture(t);
  const cache = path.join(fixture, 'app', 'cache');
  const nested = path.join(cache, 'one', 'two', 'three');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(path.join(cache, 'empty'));
  await fs.writeFile(path.join(cache, 'first.bin'), Buffer.alloc(17));
  await fs.writeFile(path.join(nested, 'second.bin'), Buffer.alloc(263));
  const result = report();
  await deleteContents(cache, result, { concurrency: 2 });
  assert.equal(result.cleanedFiles, 2);
  assert.equal(result.cleanedBytes, 280);
  assert.equal(result.skippedFiles, 0);
  assert.deepEqual(result.errors, []);
  assert.equal((await fs.lstat(cache)).isDirectory(), true);
  assert.deepEqual(await fs.readdir(cache), []);
});

test('rechecks ancestors before unlink when a checked parent becomes a junction', async (t) => {
  const fixture = await safetyFixture(t);
  const app = path.join(fixture, 'app');
  const cache = path.join(app, 'cache');
  const parked = path.join(fixture, 'original-app');
  const outside = path.join(fixture, 'protected');
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(path.join(outside, 'cache'), { recursive: true });
  const target = path.join(cache, 'keep.txt');
  await fs.writeFile(target, 'original');
  await fs.writeFile(path.join(outside, 'cache', 'keep.txt'), 'external sentinel');
  const originalLstat = fs.lstat.bind(fs);
  let replaced = false;
  // Return the original file identity, but replace its ancestor before the
  // engine's pre-unlink verification. No sleeps or scheduling assumptions.
  t.mock.method(fs, 'lstat', async (...args) => {
    const stats = await originalLstat(...args);
    if (args[0] === target && !replaced) {
      replaced = true;
      await fs.rename(app, parked);
      await fs.symlink(outside, app, 'junction');
    }
    return stats;
  });
  const result = report();
  await deleteContents(cache, result, { concurrency: 1 });
  assert.equal(replaced, true);
  assertRejected(result);
  assert.equal(await fs.readFile(path.join(outside, 'cache', 'keep.txt'), 'utf8'), 'external sentinel');
  assert.equal(await fs.readFile(path.join(parked, 'cache', 'keep.txt'), 'utf8'), 'original');
});

test('rejects a changed directory identity even without a junction and stops queued work', async (t) => {
  const fixture = await safetyFixture(t);
  const cache = path.join(fixture, 'cache');
  const parked = path.join(fixture, 'original-cache');
  await fs.mkdir(cache);
  await fs.writeFile(path.join(cache, 'first.txt'), 'first');
  await fs.writeFile(path.join(cache, 'second.txt'), 'second');
  const originalLstat = fs.lstat.bind(fs);
  let replaced = false;
  t.mock.method(fs, 'lstat', async (...args) => {
    const stats = await originalLstat(...args);
    if (path.dirname(args[0]) === cache && !replaced) {
      replaced = true;
      await fs.rename(cache, parked);
      await fs.mkdir(cache);
      await fs.writeFile(path.join(cache, 'first.txt'), 'replacement first');
      await fs.writeFile(path.join(cache, 'second.txt'), 'replacement second');
    }
    return stats;
  });
  const result = report();
  await deleteContents(cache, result, { concurrency: 1 });
  assert.equal(replaced, true);
  assertRejected(result);
  assert.match(result.errors.join('\n'), /身份或类型已变化/);
  assert.equal(await fs.readFile(path.join(cache, 'first.txt'), 'utf8'), 'replacement first');
  assert.equal(await fs.readFile(path.join(cache, 'second.txt'), 'utf8'), 'replacement second');
  assert.equal(await fs.readFile(path.join(parked, 'first.txt'), 'utf8'), 'first');
  assert.equal(await fs.readFile(path.join(parked, 'second.txt'), 'utf8'), 'second');
});

test('rechecks an empty directory after enumeration before rmdir', async (t) => {
  const fixture = await safetyFixture(t);
  const cache = path.join(fixture, 'cache');
  const nested = path.join(cache, 'nested');
  const parked = path.join(fixture, 'original-nested');
  const outside = path.join(fixture, 'protected');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'rmdir sentinel');
  const originalReaddir = fs.readdir.bind(fs);
  let replaced = false;
  t.mock.method(fs, 'readdir', async (...args) => {
    const entries = await originalReaddir(...args);
    if (args[0] === nested && !replaced) {
      replaced = true;
      await fs.rename(nested, parked);
      await fs.symlink(outside, nested, 'junction');
    }
    return entries;
  });
  const result = report();
  await deleteContents(cache, result, { concurrency: 1 });
  assert.equal(replaced, true);
  assertRejected(result);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'rmdir sentinel');
  assert.equal((await fs.lstat(nested)).isSymbolicLink(), true);
  assert.equal((await fs.lstat(parked)).isDirectory(), true);
});

test('rechecks a nonempty directory identity before post-order rmdir', async (t) => {
  const fixture = await safetyFixture(t);
  const cache = path.join(fixture, 'cache');
  const nested = path.join(cache, 'nested');
  const parked = path.join(fixture, 'original-nested');
  const outside = path.join(fixture, 'protected');
  const target = path.join(nested, 'data.bin');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(target, Buffer.alloc(29));
  await fs.writeFile(path.join(outside, 'keep.txt'), 'post-order sentinel');
  const originalUnlink = fs.unlink.bind(fs);
  let replaced = false;
  // Substitute the directory after its last child has been successfully
  // deleted, before the queued post-order directory removal can run.
  t.mock.method(fs, 'unlink', async (...args) => {
    await originalUnlink(...args);
    if (args[0] === target && !replaced) {
      replaced = true;
      await fs.rename(nested, parked);
      await fs.symlink(outside, nested, 'junction');
    }
  });
  const result = report();
  await deleteContents(cache, result, { concurrency: 1 });
  assert.equal(replaced, true);
  // Only the fixture file deleted before replacement may contribute totals.
  assert.equal(result.cleanedFiles, 1);
  assert.equal(result.cleanedBytes, 29);
  assert.ok(result.skippedFiles > 0);
  assert.match(result.errors.join('\n'), /路径安全校验失败/);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'post-order sentinel');
  assert.equal((await fs.lstat(nested)).isSymbolicLink(), true);
  assert.equal((await fs.lstat(parked)).isDirectory(), true);
});
