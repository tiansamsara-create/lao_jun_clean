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

const root = 'X:\\isolated-fixture\\';
function scanResult() {
  return {
    root, files: ['good', 'invalid', 'locked'].map((id, i) => ({
      id, name: id + '.bin', path: root + id + '.bin', canTrash: true,
      size: (i + 1) * 100, type: 'fixture', owner: 'fixture', explanation: 'isolated'
    })),
    largeCount: 3, bytes: 600, fileCount: 3, folders: 1,
    inaccessible: 0, links: 0, hardlinks: 0, cancelled: false,
    sizeNote: 'fixture logical sizes', buckets: [], directories: [],
    drive: { root, used: 1000, free: 2000 }
  };
}

// Actual main IPC registrations, with all native and filesystem operations
// replaced. Only the JavaScript source itself is read from disk.
function ipcFixture({ audit, confirm = async () => ({ response: 1 }),
  validate = async (entry) => entry.path, trash = async () => {} } = {}) {
  const handlers = new Map(), writes = [], validations = [], moves = [], dialogs = [];
  const scans = [];
  const owners = [{ name: 'fixture-owner' }];
  const event = { sender: { isDestroyed: () => false, send() {} } };
  const dependencies = {
    electron: {
      app: { whenReady: () => ({ then() {} }), on() {}, getPath: () => 'isolated-audit' },
      ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
      dialog: { showMessageBox(...args) { dialogs.push(args); return confirm(...args); } },
      shell: { async trashItem(target) { moves.push(target); return trash(target); } }
    },
    'node:fs': {
      appendFileSync(_target, text) {
        const entry = JSON.parse(text);
        writes.push(entry);
        if (audit) audit(entry);
      }
    },
    'node:path': path,
    'node:util': require('node:util'),
    'node:child_process': { execFile() { throw new Error('native commands forbidden'); } },
    './core': {
      scanAll() { throw new Error('cache scanning forbidden'); },
      cleanSelected() { throw new Error('cleanup forbidden'); },
      getDriveInfo: async () => ({ drive: 'X:' })
    },
    './cache-scan': { createCacheScan },
    './apps': {
      readRegistryApps: async () => [], normalizeRegistryApps: () => owners
    },
    './disk': {
      listDrives: async () => [{ root }],
      scanDisk: async () => { const result = scanResult(); scans.push(result); return result; },
      async validateTrashFile(...args) { validations.push(args); return validate(...args); }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8'), {
    process: { env: {} },
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), 'unexpected dependency: ' + name);
      return dependencies[name];
    }
  });
  return {
    writes, validations, moves, dialogs, scans, owners,
    invoke: (name, ...args) => handlers.get(name)(event, ...args),
    scan: () => handlers.get('disk:scan')(event, root, 100)
  };
}

function assertReport(result, removed, errors) {
  assert.deepEqual(Array.from(result.removed), removed);
  assert.deepEqual(Array.from(result.errors, (e) => ({ ...e })), errors);
  assert.equal(Object.hasOwn(result, 'auditPath'), false);
}

test('trash IPC returns successful moves and writes start/result audits normally', async () => {
  const ipc = ipcFixture();
  await ipc.scan();
  const result = await ipc.invoke('disk:trash', ['good']);
  assertReport(result, ['good'], []);
  assert.equal(Object.hasOwn(result, 'auditWarning'), false);
  assert.deepEqual(ipc.writes.map((e) => e.action), ['large-files-trash-start', 'large-files-trash-result']);
  assert.deepEqual(ipc.writes[1].report, { removed: ['good'], errors: [] });
  assert.deepEqual(ipc.moves, [root + 'good.bin']);
  assert.equal(ipc.validations[0][1], root);
  assert.strictEqual(ipc.validations[0][2], ipc.owners);
  assert.deepEqual(ipc.scans[0].files.map((f) => f.id), ['invalid', 'locked']);
  // Completed operation releases the lock; only an explicit call moves again.
  await ipc.invoke('disk:trash', ['invalid']);
  assert.equal(ipc.moves.length, 2);
});

test('result audit failure preserves successful moves and per-file validation/trash errors', async () => {
  for (const failResultAudit of [false, true]) {
    const ipc = ipcFixture({
      audit(entry) {
        if (failResultAudit && entry.action === 'large-files-trash-result') throw new Error('ENOSPC fixture');
      },
      async validate(entry) {
        if (entry.id === 'invalid') throw new Error('validation fixture failure');
        return entry.path;
      },
      async trash(target) {
        if (target.endsWith('locked.bin')) throw new Error('trash fixture failure');
      }
    });
    await ipc.scan();
    const result = await ipc.invoke('disk:trash', ['good', 'invalid', 'locked']);
    assertReport(result, ['good'], [
      { path: root + 'invalid.bin', message: 'validation fixture failure' },
      { path: root + 'locked.bin', message: 'trash fixture failure' }
    ]);
    if (failResultAudit) assert.match(result.auditWarning, /日志保存失败.*ENOSPC.*结果日志未写入/);
    else assert.equal(Object.hasOwn(result, 'auditWarning'), false);
    assert.equal(ipc.validations.length, 3);
    assert.deepEqual(ipc.moves, [root + 'good.bin', root + 'locked.bin']);
    assert.deepEqual(ipc.scans[0].files.map((f) => f.id), ['invalid', 'locked']);
    assert.equal(ipc.writes.length, 2);
    // Main's stored list was updated even when the final audit failed.
    await assert.rejects(ipc.invoke('disk:trash', ['good']), /已过期/);
    assert.equal(ipc.moves.length, 2);
    await ipc.scan(); // Finally released trashBusy after success/warning.
    assert.equal(ipc.scans.length, 2);
  }
});

test('start audit failure rejects before any validation or move, then releases lock', async () => {
  let failStart = true;
  const ipc = ipcFixture({ audit(entry) {
    if (failStart && entry.action === 'large-files-trash-start') throw new Error('start audit denied');
  } });
  await ipc.scan();
  await assert.rejects(ipc.invoke('disk:trash', ['good']), /start audit denied/);
  assert.equal(ipc.validations.length, 0);
  assert.equal(ipc.moves.length, 0);
  assert.deepEqual(ipc.writes.map((e) => e.action), ['large-files-trash-start']);
  assert.equal(ipc.scans[0].files.length, 3);
  failStart = false;
  const next = await ipc.invoke('disk:trash', ['good']);
  assertReport(next, ['good'], []);
  await ipc.scan();
});

test('dialog cancellation is zero-move/zero-audit and does not keep the lock', async () => {
  let response = 0;
  const ipc = ipcFixture({ confirm: async () => ({ response }) });
  await ipc.scan();
  const result = await ipc.invoke('disk:trash', ['good']);
  assert.equal(result.cancelled, true);
  assertReport(result, [], []);
  assert.equal(Object.hasOwn(result, 'auditWarning'), false);
  assert.equal(ipc.writes.length, 0);
  assert.equal(ipc.validations.length, 0);
  assert.equal(ipc.moves.length, 0);
  assert.equal(ipc.scans[0].files.length, 3);
  response = 1;
  assertReport(await ipc.invoke('disk:trash', ['good']), ['good'], []);
});

test('pending dialog and trash reject overlapping disk operations until request exits', async () => {
  const dialog = deferred(), moving = deferred(), moveStarted = deferred();
  const ipc = ipcFixture({
    confirm: () => dialog.promise,
    trash: () => { moveStarted.resolve(); return moving.promise; }
  });
  await ipc.scan();
  const running = ipc.invoke('disk:trash', ['good']);
  assert.equal(ipc.dialogs.length, 1);
  await assert.rejects(ipc.invoke('disk:trash', ['invalid']), /请等待扫描完成/);
  await assert.rejects(ipc.scan(), /磁盘任务正在进行中/);
  assert.equal(ipc.validations.length, 0);
  dialog.resolve({ response: 1 });
  await moveStarted.promise;
  await assert.rejects(ipc.invoke('disk:trash', ['invalid']), /请等待扫描完成/);
  await assert.rejects(ipc.scan(), /磁盘任务正在进行中/);
  assert.equal(ipc.moves.length, 1);
  moving.resolve();
  assertReport(await running, ['good'], []);
  await ipc.scan();
  assert.equal(ipc.scans.length, 2);
});

test('dialog exception releases trash lock without auditing or moving', async () => {
  let fail = true;
  const ipc = ipcFixture({ confirm: async () => {
    if (fail) throw new Error('dialog fixture failure');
    return { response: 1 };
  } });
  await ipc.scan();
  await assert.rejects(ipc.invoke('disk:trash', ['good']), /dialog fixture failure/);
  assert.equal(ipc.writes.length, 0);
  assert.equal(ipc.validations.length, 0);
  assert.equal(ipc.moves.length, 0);
  fail = false;
  assertReport(await ipc.invoke('disk:trash', ['good']), ['good'], []);
});

// Actual disk-ui event listeners run against a small DOM. Native bridge methods
// are all stubs; unsafe HTML writes of status/warnings fail immediately.
async function uiFixture() {
  const elements = new Map(), requests = [], toasts = [];
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(), listeners = new Map();
      let html = '';
      elements.set(id, {
        textContent: '', value: '', disabled: false,
        get innerHTML() { return html; },
        set innerHTML(value) {
          assert.notEqual(id, 'diskStatus', 'status must be rendered through textContent');
          html = value;
        },
        classList: {
          add: (name) => classes.add(name), remove: (name) => classes.delete(name),
          contains: (name) => classes.has(name),
          toggle(name, force) {
            const enabled = force === undefined ? !classes.has(name) : force;
            if (enabled) classes.add(name); else classes.delete(name);
          }
        },
        addEventListener: (name, callback) => listeners.set(name, callback),
        fire: (name, event = {}) => listeners.get(name)(event)
      });
    }
    return elements.get(id);
  }
  const loaded = deferred();
  const context = {
    document: { getElementById: element, querySelectorAll: () => [] },
    escapeHtml: (value) => String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c])),
    formatBytes: (bytes) => `${bytes} B`,
    showToast: (message) => toasts.push(message), switchView() {},
    window: { qingpan: {
      listDrives: async () => [{ root, free: 2000 }],
      getSystemInfo: async () => ({ drive: { drive: 'X:' } }),
      scanDisk: async () => scanResult(),
      trashFiles(ids) { const work = { ids, ...deferred() }; requests.push(work); return work.promise; },
      onDiskProgress() {},
      cancelDisk() { throw new Error('unexpected cancellation'); }
    } }
  };
  // Observe actual init completion without sleeps or a real timer.
  const scanButton = element('diskScan');
  let disabled = false;
  Object.defineProperty(scanButton, 'disabled', {
    get: () => disabled,
    set(value) { disabled = value; if (!value) loaded.resolve(); }
  });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/disk-ui.js'), 'utf8'), context);
  await loaded.promise;
  element('diskDrive').value = root;
  element('diskThreshold').value = '100';
  await element('diskScan').fire('click');
  return {
    element, requests, toasts,
    choose(id) { element('diskFiles').fire('change', { target: { dataset: { fileId: id }, checked: true } }); },
    trash: () => element('diskTrash').fire('click')
  };
}

function assertUnlocked(ui, selectedCount) {
  for (const id of ['diskScan', 'diskDrive', 'diskThreshold', 'systemScan']) {
    assert.equal(ui.element(id).disabled, false, id);
  }
  assert.equal(ui.element('diskTrash').disabled, selectedCount === 0);
  assert.equal(ui.element('diskStop').classList.contains('hidden'), true);
}

test('actual diskTrash click preserves partial outcome and safely shows result audit warning', async () => {
  for (const auditWarning of ['', '日志保存失败：<img src=x onerror=alert(1)>（结果日志未写入）']) {
    const ui = await uiFixture();
    for (const id of ['good', 'invalid', 'locked']) ui.choose(id);
    assert.match(ui.element('diskSelection').textContent, /已选 3 个文件 · 600 B/);
    const running = ui.trash();
    assert.equal(ui.requests.length, 1);
    assert.equal(ui.element('diskScan').disabled, true);
    assert.equal(ui.element('diskTrash').disabled, true);
    ui.requests[0].resolve({
      removed: ['good'], errors: [
        { path: root + 'invalid.bin', message: 'validation failure' },
        { path: root + 'locked.bin', message: 'trash failure' }
      ], ...(auditWarning ? { auditWarning } : {})
    });
    await running;
    const status = ui.element('diskStatus').textContent;
    assert.match(status, /已移入回收站 1 个文件，失败 2 个/);
    assert.match(status, /回收站仍占用磁盘；目录统计保留扫描时数值/);
    assert.match(status, /validation failure/);
    assert.match(status, /trash failure/);
    if (auditWarning) {
      assert.ok(status.includes(auditWarning));
      assert.match(status, /操作结果已保留/);
    } else assert.doesNotMatch(status, /日志保存失败|操作结果已保留/);
    assert.equal(ui.element('diskStatus').innerHTML, '');
    assert.doesNotMatch(ui.element('diskFiles').innerHTML, /data-file-id="good"/);
    assert.match(ui.element('diskFiles').innerHTML, /data-file-id="invalid"/);
    assert.match(ui.element('diskFiles').innerHTML, /data-file-id="locked"/);
    assert.match(ui.element('diskCount').textContent, /保留最大的 2 个；当前匹配 2 个/);
    assert.match(ui.element('diskSelection').textContent, /已选 0 个文件 · 0 B/);
    assert.doesNotMatch(ui.element('diskFiles').innerHTML, / checked/);
    assertUnlocked(ui, 0);
    assert.equal(ui.requests.length, 1); // No automatic retry.
    assert.deepEqual(ui.toasts, []);
  }
});

test('actual diskTrash successful and cancelled responses keep normal UI behavior', async () => {
  for (const cancelled of [false, true]) {
    const ui = await uiFixture();
    ui.choose('good');
    const before = ui.element('diskStatus').textContent;
    const running = ui.trash();
    ui.requests[0].resolve({ cancelled, removed: cancelled ? [] : ['good'], errors: [] });
    await running;
    if (cancelled) {
      assert.equal(ui.element('diskStatus').textContent, before);
      assert.match(ui.element('diskFiles').innerHTML, /data-file-id="good"/);
      assert.match(ui.element('diskCount').textContent, /保留最大的 3 个/);
      assert.match(ui.element('diskSelection').textContent, /已选 1 个文件 · 100 B/);
    } else {
      assert.match(ui.element('diskStatus').textContent, /已移入回收站 1 个文件，失败 0 个/);
      assert.match(ui.element('diskStatus').textContent, /回收站仍占用磁盘；目录统计保留扫描时数值/);
      assert.doesNotMatch(ui.element('diskFiles').innerHTML, /data-file-id="good"/);
      assert.match(ui.element('diskSelection').textContent, /已选 0 个文件 · 0 B/);
    }
    assert.doesNotMatch(ui.element('diskStatus').textContent, /日志保存失败/);
    assertUnlocked(ui, cancelled ? 1 : 0);
    assert.equal(ui.requests.length, 1);
    assert.deepEqual(ui.toasts, []);
  }
});

test('actual diskTrash rejection retains files and selection, unlocks without retry', async () => {
  const ui = await uiFixture();
  ui.choose('good');
  const running = ui.trash();
  ui.requests[0].reject(new Error('start audit denied'));
  await running;
  assert.deepEqual(ui.toasts, ['start audit denied']);
  assert.match(ui.element('diskFiles').innerHTML, /data-file-id="good"/);
  assert.match(ui.element('diskSelection').textContent, /已选 1 个文件 · 100 B/);
  assert.doesNotMatch(ui.element('diskStatus').textContent, /日志保存失败/);
  assertUnlocked(ui, 1);
  assert.equal(ui.requests.length, 1);
});
