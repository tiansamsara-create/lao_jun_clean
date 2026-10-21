const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCacheScan } = require('../src/cache-scan');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function report(overrides = {}) {
  return {
    cleanedBytes: 300, cleanedFiles: 3, skippedFiles: 0, errors: [],
    items: [{ id: 'fixture-rule', bytes: 300, files: 3 }],
    cancelled: false, ...overrides
  };
}

// Run actual main IPC registrations. Only source text is read; audit, cleanup,
// disk queries, Electron startup and native operations are all isolated stubs.
function ipcFixture({ auditError, drive = async () => ({ free: 10 }) } = {}) {
  const handlers = new Map(), cleans = [], writes = [];
  const event = { sender: { isDestroyed: () => false, send() {} } };
  const dependencies = {
    electron: {
      app: { whenReady: () => ({ then() {} }), on() {}, getPath: () => 'isolated-audit' },
      ipcMain: { handle: (name, callback) => handlers.set(name, callback) }
    },
    'node:fs': {
      appendFileSync(...args) {
        writes.push(args);
        if (auditError) throw auditError;
      }
    },
    'node:path': path,
    'node:util': require('node:util'),
    'node:child_process': { execFile() { throw new Error('native operations forbidden'); } },
    './core': {
      scanAll() { throw new Error('scan forbidden'); },
      cleanSelected(ids, options) {
        const work = { ids, ...options, ...deferred() };
        cleans.push(work);
        return work.promise;
      },
      getDriveInfo: drive
    },
    './cache-scan': { createCacheScan },
    './apps': {},
    './disk': {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8'), {
    process: { env: {} },
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), 'unexpected dependency: ' + name);
      return dependencies[name];
    }
  });
  return { cleans, writes, invoke: (name, ...args) => handlers.get(name)(event, ...args) };
}

test('clean IPC returns real report and audit path when writing succeeds', async () => {
  const ipc = ipcFixture();
  const actual = report();
  const running = ipc.invoke('clean:start', ['fixture-rule']);
  ipc.cleans[0].resolve(actual);
  const result = await running;
  assert.equal(result.auditPath, path.join('isolated-audit', 'cleanup-audit.jsonl'));
  assert.equal(Object.hasOwn(result, 'auditWarning'), false);
  for (const key of Object.keys(actual)) assert.strictEqual(result[key], actual[key]);
  assert.equal(ipc.writes.length, 1);
  const entry = JSON.parse(ipc.writes[0][1]);
  assert.equal(entry.action, 'clean');
  assert.deepEqual(entry.selectedIds, ['fixture-rule']);
  assert.deepEqual(entry.report, actual);
  assert.equal(ipc.invoke('clean:cancel'), false);
  assert.equal(ipc.cleans.length, 1);
});

test('audit failure preserves success, skipped and cancelled reports without retrying cleanup', async () => {
  for (const overrides of [
    {},
    { skippedFiles: 2, errors: ['fixture locked'] },
    { cancelled: true, skippedFiles: 2, errors: ['fixture locked'] }
  ]) {
    const ipc = ipcFixture({ auditError: new Error('ENOSPC fixture') });
    const actual = report(overrides);
    const snapshot = JSON.stringify(actual);
    const running = ipc.invoke('clean:start', ['fixture-rule']);
    ipc.cleans[0].resolve(actual);
    const result = await running;
    for (const key of Object.keys(actual)) assert.strictEqual(result[key], actual[key]);
    assert.equal(JSON.stringify(actual), snapshot);
    assert.equal(Object.hasOwn(result, 'auditPath'), false);
    assert.match(result.auditWarning, /日志保存失败.*ENOSPC.*未写入/);
    assert.equal(ipc.writes.length, 1);
    assert.equal(ipc.cleans.length, 1);
    assert.equal(ipc.invoke('clean:cancel'), false);

    // Finally releases the token: another explicitly requested cleanup may start.
    const next = ipc.invoke('clean:start', ['fixture-rule']);
    assert.equal(ipc.cleans.length, 2);
    ipc.cleans[1].resolve(report({ cleanedBytes: 0, cleanedFiles: 0, items: [] }));
    await next;
  }
});

test('audit failure retains clean token until the whole request exits', async () => {
  const queried = deferred(), drive = deferred();
  const ipc = ipcFixture({
    auditError: new Error('EACCES fixture'),
    drive: () => { queried.resolve(); return drive.promise; }
  });
  const running = ipc.invoke('clean:start', ['fixture-rule']);
  ipc.cleans[0].resolve(report());
  await queried.promise;
  assert.equal(ipc.invoke('clean:cancel'), true);
  assert.equal(ipc.cleans[0].cancelToken.cancelled, true);
  assert.throws(() => ipc.invoke('scan:start', 'blocked'), /清理正在进行中/);
  await assert.rejects(ipc.invoke('clean:start', ['fixture-rule']), /清理正在进行中/);
  assert.equal(ipc.cleans.length, 1);
  drive.resolve({ free: 20 });
  const result = await running;
  assert.equal(result.cleanedBytes, 300);
  assert.equal(result.drive.free, 20);
  assert.match(result.auditWarning, /日志保存失败/);
  assert.equal(ipc.invoke('clean:cancel'), false);
  const next = ipc.invoke('clean:start', ['fixture-rule']);
  ipc.cleans[1].resolve(report());
  await next;
});

test('cleanup rejection still rejects IPC, skips audit and releases the token', async () => {
  const ipc = ipcFixture({ auditError: new Error('must not be reached') });
  const running = ipc.invoke('clean:start', ['fixture-rule']);
  const error = new Error('real cleanup failure');
  const rejected = assert.rejects(running, (received) => received === error);
  ipc.cleans[0].reject(error);
  await rejected;
  assert.equal(ipc.writes.length, 0);
  assert.equal(ipc.invoke('clean:cancel'), false);
  const next = ipc.invoke('clean:start', ['fixture-rule']);
  ipc.cleans[1].resolve(report());
  assert.match((await next).auditWarning, /日志保存失败/);
});

// Minimal DOM runs actual runClean/renderResults, with no native bridge or real
// timers. Any attempted HTML rendering of the audit warning fails this fixture.
function uiFixture() {
  const elements = new Map(), cleans = [];
  function element(key) {
    if (!elements.has(key)) {
      const classes = new Set();
      let html = '';
      elements.set(key, {
        textContent: '', disabled: false, value: '', dataset: {},
        get innerHTML() { return html; },
        set innerHTML(value) {
          assert.notEqual(key, '#resultMessage', 'result message must use textContent');
          html = value;
        },
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
    CSS: { escape: (value) => value },
    setTimeout: () => 1, clearTimeout() {}
  });
  context.window = { qingpan: {
    getSystemInfo: async () => ({ computerName: 'fixture' }),
    clean(ids) { const job = { ids, ...deferred() }; cleans.push(job); return job.promise; },
    onScanProgress() {}, onCleanProgress() {}, onAppsProgress() {}
  } };
  for (const name of ['cache-scan-controller.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer', name), 'utf8'), context);
  }
  const run = (code) => vm.runInContext(code, context);
  run(`state.scanned = true;
    state.items = [{
      id: 'fixture-rule', detected: true, bytes: 1000, files: 10,
      app: 'Fixture', category: '系统', item: 'Cache',
      description: 'isolated', risk: 'safe', paths: []
    }];
    state.selected = new Set(['fixture-rule']);`);
  element('#resultModal').classList.add('hidden');
  return { run, element, cleans };
}

test('actual runClean displays audit warnings safely and keeps all result branches', async () => {
  for (const overrides of [
    { auditWarning: '日志保存失败：<img src=x onerror=alert(1)>（本次清理记录未写入）' },
    { auditWarning: '日志保存失败：ENOSPC', skippedFiles: 2, errors: ['fixture locked'] },
    { auditWarning: '日志保存失败：EACCES', cancelled: true, skippedFiles: 2, errors: ['fixture locked'] },
    {},
    { cancelled: true }
  ]) {
    const ui = uiFixture();
    const running = ui.run('runClean()');
    assert.equal(ui.cleans.length, 1);
    assert.equal(ui.run('state.busy'), true);
    assert.equal(ui.element('#scanButton').disabled, true);
    const actual = report(overrides);
    ui.cleans[0].resolve(actual);
    await running;

    assert.equal(ui.element('#resultModal').classList.contains('hidden'), false);
    assert.equal(ui.element('#cleanedSize').textContent, '300 B');
    assert.equal(ui.element('#cleanedFiles').textContent, '3');
    assert.equal(ui.element('#skippedFiles').textContent, String(actual.skippedFiles));
    assert.equal(ui.element('#resultTitle').textContent, actual.cancelled ? '清理已停止' : '清理完成');
    const message = ui.element('#resultMessage').textContent;
    if (actual.auditWarning) {
      assert.match(message, /清理结果已保留/);
      assert.ok(message.includes(actual.auditWarning));
      assert.equal(ui.element('#resultMessage').innerHTML, '');
    } else {
      assert.doesNotMatch(message, /日志保存失败|清理结果已保留/);
    }
    if (actual.cancelled) assert.match(message, /停止前已完成/);
    else if (actual.errors.length) assert.match(message, /2 个.*跳过/);
    else assert.match(message, /所选缓存已清理完成/);
    assert.equal(ui.run('state.items[0].bytes'), 700);
    assert.equal(ui.run('state.items[0].files'), 7);
    assert.equal(ui.run('state.selected.size'), 0);
    assert.equal(ui.run('state.busy'), false);
    assert.equal(ui.element('#scanButton').disabled, false);
    assert.equal(ui.element('#searchInput').disabled, false);
    assert.equal(ui.element('#clearSelection').disabled, false);
    assert.equal(ui.element('#cleanButton').disabled, true); // Selection cleared.
    assert.equal(ui.element('#progressWrap').classList.contains('hidden'), true);
    assert.match(ui.element('#scanHint').textContent, /列表已扣除本次删除量/);
    assert.doesNotMatch(ui.element('#toast').textContent, /清理失败/);
    assert.equal(ui.cleans.length, 1); // Never automatically retries deletion.
  }
});

test('actual runClean still shows cleanup rejection without modifying old results', async () => {
  const ui = uiFixture();
  const running = ui.run('runClean()');
  ui.cleans[0].reject(new Error('real cleanup failure'));
  await running;
  assert.match(ui.element('#toast').textContent, /清理失败.*real cleanup failure/);
  assert.equal(ui.element('#resultModal').classList.contains('hidden'), true);
  assert.equal(ui.run('state.items[0].bytes'), 1000);
  assert.equal(ui.run('state.items[0].files'), 10);
  assert.equal(ui.run("state.selected.has('fixture-rule')"), true);
  assert.equal(ui.run('state.busy'), false);
  assert.equal(ui.element('#scanButton').disabled, false);
  assert.equal(ui.element('#cleanButton').disabled, false);
  assert.equal(ui.cleans.length, 1);
});
