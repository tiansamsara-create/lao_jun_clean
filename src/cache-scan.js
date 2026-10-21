// Cache scanning owns its own token; disk/app scanning remain independent.
function createCacheScan({ scanAll, getDriveInfo }) {
  let active = null;
  const pending = new Set();
  const owns = (task) => active === task && !task.token.cancelled;
  return {
    // Includes cancelled/superseded tasks until their own finally has run.
    get busy() { return pending.size > 0; },
    async start(event, scanId) {
      if (typeof scanId !== 'string' || !scanId || scanId.length > 100) {
        throw new Error('扫描任务标识无效');
      }
      if (active) active.token.cancelled = true;
      const task = { token: { cancelled: false }, sender: event.sender, scanId };
      active = task;
      pending.add(task);
      const cancelled = () => ({ cancelled: true, items: [], scanId });
      try {
        const items = await scanAll({
          cancelToken: task.token,
          onProgress: (progress) => {
            if (owns(task) && !task.sender.isDestroyed()) {
              task.sender.send('scan:progress', { ...progress, scanId });
            }
          }
        });
        if (!owns(task)) return cancelled();
        const drive = await getDriveInfo();
        // Cancel/supersede can happen while the asynchronous disk query runs.
        if (!owns(task)) return cancelled();
        return { cancelled: false, items, drive, scannedAt: new Date().toISOString(), scanId };
      } finally {
        pending.delete(task);
        if (active === task) active = null;
      }
    },
    cancel(event, scanId) {
      if (!active || active.sender !== event.sender || active.scanId !== scanId) return false;
      active.token.cancelled = true;
      return true;
    }
  };
}

module.exports = { createCacheScan };
