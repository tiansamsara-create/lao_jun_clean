const fs = require('node:fs').promises;
const path = require('node:path');

// A bounded queue: children become runnable only after their parent was checked.
// Directory removal is post-order and never recursive at the filesystem API level.
async function deleteContents(root, report, { cancelToken = {}, onProgress = () => {}, concurrency = 16 } = {}) {
  let unsafe = false;
  const stopped = () => cancelToken.cancelled || unsafe;
  const noteError = (target, error) => {
    if (error.code === 'ENOENT') return;
    report.skippedFiles++;
    if (report.errors.length < 100) report.errors.push(`${target}: ${error.message}`);
  };
  const rejectPath = (target, reason) => {
    // Stop this root, including queued work; active workers recheck before mutation.
    unsafe = true;
    const error = new Error(`路径安全校验失败：${target}：${reason}`);
    error.code = 'EUNSAFEPATH';
    throw error;
  };
  async function snapshot(target, expected) {
    let stats;
    try { stats = await fs.lstat(target, { bigint: true }); }
    catch (error) {
      // A vanished previously checked path is a change, not an ignorable ENOENT.
      if (expected) rejectPath(target, `无法重新核对路径（${error.code || error.message}）`);
      throw error;
    }
    if (stats.isSymbolicLink()) rejectPath(target, '拒绝符号链接或 junction');
    if (expected && (stats.dev !== expected.stats.dev || stats.ino !== expected.stats.ino ||
        stats.birthtimeNs !== expected.stats.birthtimeNs || stats.mode !== expected.stats.mode)) {
      rejectPath(target, '路径身份或类型已变化');
    }
    return { target, stats };
  }
  async function verifyChain(chain) {
    let stats = true;
    for (const entry of chain) {
      if (stopped()) return null;
      stats = (await snapshot(entry.target, entry)).stats;
    }
    return stopped() ? null : stats;
  }

  // Start at the volume/share root: checking only the cache root misses junctions
  // in its parents. Keep immutable identity snapshots, not directory timestamps
  // (which legitimately change when children are removed).
  const rootPath = path.resolve(root);
  const ancestors = [];
  for (let target = rootPath; ; target = path.dirname(target)) {
    ancestors.push(target);
    if (path.dirname(target) === target) break;
  }
  const initialChain = [];
  try {
    for (const target of ancestors.reverse()) {
      if (stopped()) return;
      const entry = await snapshot(target);
      if (target !== rootPath && !entry.stats.isDirectory()) rejectPath(target, '祖先路径不是目录');
      initialChain.push(entry);
    }
  } catch (error) { noteError(rootPath, error); return; }

  const queue = [{ target: rootPath, parent: null, keep: true,
    ancestors: initialChain.slice(0, -1), snapshot: initialChain[initialChain.length - 1] }];
  let cursor = 0;
  let active = 0;
  const finished = (job) => {
    if (job.parent && --job.parent.remaining === 0) queue.push({ ...job.parent, remove: true });
  };
  async function processJob(job) {
    try {
      onProgress(job.target);
      if (!await verifyChain(job.ancestors)) return;
      const entry = await snapshot(job.target, job.snapshot);
      if (stopped()) return;
      const chain = [...job.ancestors, entry];
      if (job.remove) {
        if (!job.keep && await verifyChain(chain) && !stopped()) await fs.rmdir(job.target);
        return;
      }
      if (entry.stats.isDirectory()) {
        const entries = await fs.readdir(job.target);
        // Recheck after enumeration as well, before trusting child names/rmdir.
        if (!await verifyChain(chain)) return;
        if (entries.length) {
          const parent = { ...job, snapshot: entry, remaining: entries.length };
          for (const name of entries) queue.push({ target: path.join(job.target, name), parent, ancestors: chain });
          job.deferred = true;
        } else if (!job.keep && !stopped()) await fs.rmdir(job.target);
      } else if (entry.stats.isFile()) {
        // Path-based Node APIs cannot make check + unlink atomic. Recheck the
        // entire captured chain immediately before mutation; never follow links.
        const stats = await verifyChain(chain);
        if (!stats || stopped()) return;
        await fs.unlink(job.target);
        report.cleanedFiles++;
        report.cleanedBytes += Number(stats.size);
      }
    } catch (error) {
      // Nonempty parents are expected when a locked child was skipped.
      if (!(job.remove && error.code === 'ENOTEMPTY')) noteError(job.target, error);
    } finally {
      if (!job.deferred) finished(job);
      onProgress(job.target);
    }
  }
  await new Promise((resolve) => {
    function pump() {
      while (!stopped() && active < Math.max(1, Math.min(32, concurrency)) && cursor < queue.length) {
        const job = queue[cursor];
        queue[cursor++] = null;
        active++;
        processJob(job).finally(() => { active--; pump(); });
      }
      if (!active && (stopped() || cursor === queue.length)) resolve();
    }
    pump();
  });
}

module.exports = { deleteContents };
