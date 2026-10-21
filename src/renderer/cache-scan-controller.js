// Shared by the browser and isolated Node tests; no filesystem or DOM access.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = { createScanController: factory };
  else root.createScanController = factory;
})(typeof globalThis === 'object' ? globalThis : this, function createScanController({
  api, onBusy, onComplete, onCancelled, onError, onStopping, onCancelError, onProgress,
  makeId = () => globalThis.crypto.randomUUID(), cancelTimeoutMs = 5000,
  setTimer = setTimeout, clearTimer = clearTimeout
}) {
  let active = null;
  const owns = (task) => active === task;
  return {
    get busy() { return active !== null; },
    get stopping() { return Boolean(active && active.stopping); },
    async start() {
      if (active) return;
      const task = { id: makeId(), stopping: false, discard: false, attempt: 0 };
      task.done = new Promise((resolve) => { task.finish = resolve; });
      active = task;
      onBusy(true);
      try {
        const result = await api.scan(task.id);
        if (!owns(task)) return;
        // Even if completion beat the cancel IPC, a locally stopped scan must
        // not replace the previous complete result/selection.
        if (task.discard || result.cancelled) onCancelled();
        else if (result.scanId === task.id) onComplete(result);
        else throw new Error('扫描任务标识不匹配，请重试');
      } catch (error) {
        if (owns(task)) onError(error);
      } finally {
        task.finish();
        if (owns(task)) {
          active = null;
          onBusy(false);
        }
      }
    },
    async stop() {
      const task = active;
      if (!task || task.stopping) return;
      task.discard = true;
      task.stopping = true;
      const attempt = ++task.attempt;
      onStopping();
      let timer;
      try {
        // Bound both acknowledgement and task-exit waiting. A timeout permits
        // another stop request, NOT a new scan while the original still runs.
        await Promise.race([
          task.done,
          Promise.resolve().then(() => api.cancelScan(task.id)).then(() => task.done),
          new Promise((_, reject) => {
            timer = setTimer(() => reject(new Error('停止等待超时，可再次点击停止扫描')), cancelTimeoutMs);
          })
        ]);
        // true (token cancelled) and false (already exited) both wait for start.
      } catch (error) {
        if (owns(task) && task.attempt === attempt) {
          task.stopping = false;
          onCancelError(error);
        }
      } finally {
        clearTimer(timer);
      }
    },
    progress(value) {
      if (active && !active.discard && !active.stopping && value.scanId === active.id) onProgress(value);
    }
  };
});
