const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCacheScan } = require('../src/cache-scan');
const { createScanController } = require('../src/renderer/cache-scan-controller');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function mainFixture(getDriveInfo = async () => ({ free: 10 })) {
  const jobs = [], events = [];
  const sender = { isDestroyed: () => false, send: (...args) => events.push(args) };
  const event = { sender };
  const service = createCacheScan({
    scanAll(options) {
      const job = { ...options, ...deferred() };
      jobs.push(job);
      return job.promise;
    },
    getDriveInfo
  });
  return { service, jobs, events, event };
}

test('cache cancel owns only the active sender/id and handles no active scan', async () => {
  const { service, jobs, event } = mainFixture();
  assert.equal(service.cancel(event, 'one'), false);
  const running = service.start(event, 'one');
  assert.equal(service.cancel(event, 'wrong'), false);
  assert.equal(service.cancel({ sender: {} }, 'one'), false);
  assert.equal(jobs[0].cancelToken.cancelled, false);
  assert.equal(service.cancel(event, 'one'), true);
  assert.equal(jobs[0].cancelToken.cancelled, true);
  assert.equal(service.cancel(event, 'one'), true);
  jobs[0].resolve(['partial']);
  assert.deepEqual(await running, { cancelled: true, items: [], scanId: 'one' });
  assert.equal(service.cancel(event, 'one'), false);
});

test('old task progress and finalization cannot affect the new cache task', async () => {
  const { service, jobs, events, event } = mainFixture();
  const old = service.start(event, 'old');
  const latest = service.start(event, 'new');
  assert.equal(jobs[0].cancelToken.cancelled, true);
  jobs[0].onProgress({ current: 9 });
  jobs[1].onProgress({ current: 1 });
  assert.deepEqual(events, [['scan:progress', { current: 1, scanId: 'new' }]]);
  jobs[0].resolve(['old result']);
  assert.equal((await old).cancelled, true);
  assert.equal(service.cancel(event, 'old'), false);
  assert.equal(service.cancel(event, 'new'), true);
  jobs[1].onProgress({ current: 2 });
  assert.equal(events.length, 1);
  jobs[1].resolve(['new partial']);
  assert.equal((await latest).cancelled, true);
});

test('cancellation during asynchronous drive query discards complete items', async () => {
  const drive = deferred(), queried = deferred();
  const { service, jobs, event } = mainFixture(() => { queried.resolve(); return drive.promise; });
  const running = service.start(event, 'one');
  jobs[0].resolve(['complete']);
  await queried.promise;
  assert.equal(service.cancel(event, 'one'), true);
  drive.resolve({ free: 20 });
  assert.deepEqual(await running, { cancelled: true, items: [], scanId: 'one' });
});

test('scan failure releases main token and permits another task', async () => {
  const { service, jobs, event } = mainFixture();
  const first = service.start(event, 'first');
  jobs[0].reject(new Error('scan failed'));
  await assert.rejects(first, /scan failed/);
  assert.equal(service.cancel(event, 'first'), false);
  const second = service.start(event, 'second');
  jobs[1].resolve([]);
  assert.equal((await second).cancelled, false);
});

// Exercise the real main-process IPC registrations with controlled scan/clean
// promises. Electron startup, audit writes and native operations are stubbed.
function ipcFixture() {
  const handlers = new Map(), scans = [], cleans = [];
  const sender = { isDestroyed: () => false, send() {} };
  const event = { sender };
  const core = {
    scanAll(options) {
      const job = { ...options, ...deferred() };
      scans.push(job);
      return job.promise;
    },
    cleanSelected(ids, options) {
      const job = { ids, ...options, ...deferred() };
      cleans.push(job);
      return job.promise;
    },
    getDriveInfo: async () => ({ free: 10 })
  };
  const mocks = {
    electron: {
      app: { whenReady: () => ({ then() {} }), on() {}, getPath: () => 'isolated-audit' },
      ipcMain: { handle: (name, callback) => handlers.set(name, callback) }
    },
    'node:fs': { appendFileSync() {} },
    'node:path': path,
    'node:child_process': { execFile() { throw new Error('native commands forbidden'); } },
    'node:util': require('node:util'),
    './core': core,
    './cache-scan': { createCacheScan },
    './apps': {},
    './disk': {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8'), {
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), 'unexpected dependency: ' + name);
      return mocks[name];
    },
    process: { env: {} }
  });
  return {
    scans, cleans,
    invoke: (name, ...args) => handlers.get(name)(event, ...args)
  };
}

test('IPC rejects cache scans while cleaning, including cancellation until clean exits', async () => {
  const ipc = ipcFixture();
  const cleaning = ipc.invoke('clean:start', ['fixture-rule']);
  // The clean token is acquired synchronously, before the first await.
  assert.equal(ipc.cleans.length, 1);
  assert.throws(() => ipc.invoke('scan:start', 'blocked'), /清理正在进行中/);
  assert.equal(ipc.scans.length, 0);
  assert.equal(ipc.invoke('clean:cancel'), true);
  assert.equal(ipc.cleans[0].cancelToken.cancelled, true);
  assert.throws(() => ipc.invoke('scan:start', 'still-blocked'), /清理正在进行中/);
  ipc.cleans[0].resolve({ cleanedFiles: 0 });
  await cleaning;
  const scanning = ipc.invoke('scan:start', 'allowed');
  assert.equal(ipc.scans.length, 1);
  ipc.scans[0].resolve([]);
  assert.equal((await scanning).cancelled, false);
});

test('IPC rejects cleaning immediately and throughout cache cancellation wait', async () => {
  const ipc = ipcFixture();
  const scanning = ipc.invoke('scan:start', 'fixture-scan');
  assert.equal(ipc.scans.length, 1);
  await assert.rejects(ipc.invoke('clean:start', ['fixture-rule']), /缓存扫描尚未退出/);
  assert.equal(ipc.invoke('scan:cancel', 'fixture-scan'), true);
  assert.equal(ipc.scans[0].cancelToken.cancelled, true);
  await assert.rejects(ipc.invoke('clean:start', ['fixture-rule']), /缓存扫描尚未退出/);
  assert.equal(ipc.cleans.length, 0);
  ipc.scans[0].resolve([]);
  assert.equal((await scanning).cancelled, true);
  const cleaning = ipc.invoke('clean:start', ['fixture-rule']);
  assert.equal(ipc.cleans.length, 1);
  ipc.cleans[0].resolve({});
  await cleaning;
});

test('busy counts superseded scans until late exceptional exit, even after newest completes', async () => {
  const { service, jobs, event } = mainFixture();
  assert.equal(service.busy, false);
  const descriptor = Object.getOwnPropertyDescriptor(service, 'busy');
  assert.equal(descriptor.set, undefined);
  const old = service.start(event, 'old');
  const latest = service.start(event, 'latest');
  assert.equal(service.busy, true);
  jobs[1].resolve([]);
  await latest;
  assert.equal(service.cancel(event, 'latest'), false);
  assert.equal(service.busy, true);
  const rejected = assert.rejects(old, /late scan failure/);
  jobs[0].reject(new Error('late scan failure'));
  await rejected;
  assert.equal(service.busy, false);

  const drive = deferred(), queried = deferred();
  const fixture = mainFixture(() => { queried.resolve(); return drive.promise; });
  const scanning = fixture.service.start(fixture.event, 'drive-error');
  fixture.jobs[0].resolve([]);
  await queried.promise;
  assert.equal(fixture.service.busy, true);
  const driveRejected = assert.rejects(scanning, /drive failure/);
  drive.reject(new Error('drive failure'));
  await driveRejected;
  assert.equal(fixture.service.busy, false);
});

test('IPC keeps late superseded scan locked and releases scan/clean failures', async () => {
  const ipc = ipcFixture();
  const old = ipc.invoke('scan:start', 'old');
  const latest = ipc.invoke('scan:start', 'latest');
  ipc.scans[1].resolve([]);
  await latest;
  await assert.rejects(ipc.invoke('clean:start', ['fixture-rule']), /缓存扫描尚未退出/);
  assert.equal(ipc.cleans.length, 0);
  const failedOld = assert.rejects(old, /old failure/);
  ipc.scans[0].reject(new Error('old failure'));
  await failedOld;

  const cleaning = ipc.invoke('clean:start', ['fixture-rule']);
  assert.equal(ipc.cleans.length, 1);
  const failedClean = assert.rejects(cleaning, /clean failure/);
  ipc.cleans[0].reject(new Error('clean failure'));
  await failedClean;
  const next = ipc.invoke('scan:start', 'after-failures');
  assert.equal(ipc.scans.length, 3);
  ipc.scans[2].resolve([]);
  assert.equal((await next).cancelled, false);
});

test('preload invokes dedicated scan cancellation without clean/disk/app IPC', async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
        ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(true); } }
      };
    }
  });
  await bridge.scan('one');
  await bridge.cancelScan('one');
  assert.deepEqual(calls, [['scan:start', 'one'], ['scan:cancel', 'one']]);
});

// Minimal DOM and IPC simulation runs the actual renderer callbacks. No Electron,
// filesystem scans, user paths, deletion APIs or real timers are invoked.
function uiFixture() {
  const elements = new Map(), scans = [], cancels = [], timers = new Map();
  let nextTimer = 0, nextId = 0, progress;
  function element(key) {
    if (!elements.has(key)) {
      const classes = new Set();
      elements.set(key, {
        textContent: '', disabled: false, innerHTML: '', value: '', dataset: {},
        style: { width: '', setProperty() {} },
        classList: {
          add: (name) => classes.add(name), remove: (name) => classes.delete(name),
          contains: (name) => classes.has(name),
          toggle(name, force) {
            const enabled = force === undefined ? !classes.has(name) : force;
            if (enabled) classes.add(name); else classes.delete(name);
          }
        },
        querySelector: (selector) => element(key + ' ' + selector),
        querySelectorAll: () => [], addEventListener() {}, appendChild() {}, remove() {}
      });
    }
    return elements.get(key);
  }
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [], createElement: () => element('created') },
    crypto: { randomUUID: () => 'scan-' + ++nextId },
    CSS: { escape: (value) => value },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  context.window = {
    qingpan: {
      getSystemInfo: async () => ({ computerName: 'fixture' }),
      scan(id) { const job = { id, ...deferred() }; scans.push(job); return job.promise; },
      cancelScan(id) { const job = { id, ...deferred() }; cancels.push(job); return job.promise; },
      onScanProgress(callback) { progress = callback; },
      onCleanProgress() {}, onAppsProgress() {}
    }
  };
  for (const name of ['cache-scan-controller.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8'), context);
  }
  return {
    element, scans, cancels, timers,
    run: (code) => vm.runInContext(code, context),
    progress: (id) => progress({ scanId: id, current: 1, total: 2, app: 'fixture' }),
    complete(index, extra = {}) {
      scans[index].resolve({ scanId: scans[index].id, cancelled: false, items: [], ...extra });
    }
  };
}

test('first UI cancellation waits for exit, ignores progress and can scan again', async () => {
  const ui = uiFixture();
  const first = ui.run('runScan()');
  assert.equal(ui.element('#scanButton span').textContent, '停止扫描');
  assert.equal(ui.element('#scanButton').disabled, false);
  const stop = ui.run('runScan()');
  await tick();
  assert.equal(ui.element('#scanButton span').textContent, '正在停止…');
  assert.equal(ui.element('#scanButton').disabled, true);
  await ui.run('runScan()');
  assert.equal(ui.cancels.length, 1);
  const stoppingText = ui.element('#progressText').textContent;
  ui.progress(ui.scans[0].id);
  assert.equal(ui.element('#progressText').textContent, stoppingText);
  ui.cancels[0].resolve(true);
  await tick();
  assert.equal(ui.run('state.busy'), true);
  ui.complete(0, { cancelled: true, items: ['partial'] });
  await Promise.all([first, stop]);
  assert.equal(ui.run('state.scanned'), false);
  assert.equal(ui.run('state.items.length'), 0);
  assert.equal(ui.element('#scanButton span').textContent, '开始扫描');
  assert.equal(ui.element('#scanButton').disabled, false);
  assert.equal(ui.run('state.busy'), false);
  assert.equal(ui.element('#progressWrap').classList.contains('hidden'), true);
  const second = ui.run('runScan()');
  const preparing = ui.element('#progressText').textContent;
  ui.progress(ui.scans[0].id);
  assert.equal(ui.element('#progressText').textContent, preparing);
  ui.progress(ui.scans[1].id);
  assert.match(ui.element('#progressText').textContent, /正在检查/);
  ui.complete(1);
  await second;
  assert.equal(ui.run('state.scanned'), true);
  assert.equal(ui.element('#scanButton span').textContent, '重新扫描');
});

test('stopped UI scan preserves previous complete items and selection even if completion wins IPC', async () => {
  const ui = uiFixture();
  ui.run("state.scanned = true; state.items = [{ id: 'saved', detected: false }]; state.selected = new Set(['saved']); state.expanded = new Set(['saved-group']);");
  const first = ui.run('runScan()');
  const stop = ui.run('runScan()');
  await tick();
  // Completion succeeds before cancel acknowledgement, but must be discarded.
  ui.complete(0);
  await Promise.all([first, stop]);
  assert.equal(ui.run('state.items[0].id'), 'saved');
  assert.equal(ui.run("state.selected.has('saved')"), true);
  assert.equal(ui.run("state.expanded.has('saved-group')"), true);
  assert.equal(ui.element('#scanButton span').textContent, '重新扫描');
  assert.match(ui.element('#scanHint').textContent, /保留上次完整结果和选择/);
  const second = ui.run('runScan()');
  ui.cancels[0].reject(new Error('late cancel failure'));
  await tick();
  assert.equal(ui.element('#scanButton span').textContent, '停止扫描');
  assert.equal(ui.element('#scanButton').disabled, false);
  ui.complete(1);
  await second;
});

test('failed UI cancellation restores stop/retry but never starts overlapping scan', async () => {
  const ui = uiFixture();
  const running = ui.run('runScan()');
  const stop = ui.run('runScan()');
  await tick();
  ui.cancels[0].reject(new Error('IPC failed'));
  await stop;
  assert.equal(ui.run('state.busy'), true);
  assert.equal(ui.element('#scanButton').disabled, false);
  assert.equal(ui.element('#scanButton span').textContent, '停止扫描');
  assert.match(ui.element('#scanHint').textContent, /重试停止/);
  const retry = ui.run('runScan()');
  await tick();
  assert.equal(ui.scans.length, 1);
  assert.equal(ui.cancels.length, 2);
  ui.cancels[1].resolve(true);
  ui.complete(0, { cancelled: true });
  await Promise.all([running, retry]);
  assert.equal(ui.element('#scanButton span').textContent, '开始扫描');
});

test('cancel acknowledgement or exit timeout allows retry without abandoning active UI task', async () => {
  // Repeat with a lost acknowledgement and an acknowledged-but-slow task.
  for (const acknowledged of [false, true]) {
    const ui = uiFixture();
    const running = ui.run('runScan()');
    const stop = ui.run('runScan()');
    await tick();
    if (acknowledged) { ui.cancels[0].resolve(true); await tick(); }
    // The only timer is the controller's bounded stop wait (no toast yet).
    assert.equal(ui.timers.size, 1);
    [...ui.timers.values()][0]();
    await stop;
    assert.equal(ui.run('state.busy'), true);
    assert.equal(ui.element('#scanButton').disabled, false);
    assert.equal(ui.element('#scanButton span').textContent, '停止扫描');
    const retry = ui.run('runScan()');
    await tick();
    assert.equal(ui.scans.length, 1);
    ui.cancels[1].resolve(true);
    ui.complete(0, { cancelled: true });
    await Promise.all([running, retry]);
    assert.equal(ui.run('state.busy'), false);
    assert.equal(ui.element('#scanButton span').textContent, '开始扫描');
    // Late completion/failure from the timed-out request cannot change idle UI.
    if (!acknowledged) ui.cancels[0].reject(new Error('late failure'));
    await tick();
    assert.equal(ui.element('#scanButton span').textContent, '开始扫描');
  }
});

test('UI scan rejection releases busy state and remains retryable', async () => {
  const ui = uiFixture();
  const running = ui.run('runScan()');
  ui.scans[0].reject(new Error('isolated scan failure'));
  await running;
  assert.equal(ui.run('state.busy'), false);
  assert.equal(ui.element('#scanButton').disabled, false);
  assert.equal(ui.element('#scanButton span').textContent, '开始扫描');
  assert.match(ui.element('#scanHint').textContent, /扫描失败/);
  const retry = ui.run('runScan()');
  ui.complete(1);
  await retry;
});

test('controller ignores obsolete progress after completion and never invokes cleanup', async () => {
  const work = deferred();
  const values = [];
  const controller = createScanController({
    api: { scan: () => work.promise },
    makeId: () => 'one',
    onBusy() {}, onComplete() {}, onCancelled() {}, onError() {},
    onStopping() {}, onCancelError() {}, onProgress: (value) => values.push(value)
  });
  const running = controller.start();
  controller.progress({ scanId: 'other' });
  controller.progress({ scanId: 'one' });
  work.resolve({ scanId: 'one', cancelled: false });
  await running;
  controller.progress({ scanId: 'one' });
  assert.equal(values.length, 1);
  assert.equal(controller.busy, false);
});
