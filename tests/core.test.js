const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { expandPattern, measurePath, assertSafeTarget, normalize, resolveUniqueTargets, cleanSelected, globMatchesPath } = require('../src/core');
const { expandEnvironment } = require('../src/rules');

test('expands environment placeholders case-insensitively', () => {
  const result = expandEnvironment('%localappdata%/Demo/Cache', { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local' });
  assert.equal(result, path.join('C:\\Users\\Test\\AppData\\Local', 'Demo', 'Cache'));
});

test('expands wildcard segments and ignores missing paths', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qingpan-pattern-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'Profile 1', 'Cache'), { recursive: true });
  await fsp.mkdir(path.join(root, 'Profile 2', 'Cache'), { recursive: true });
  const matches = await expandPattern(path.join(root, 'Profile *', 'Cache'));
  assert.deepEqual(matches.map(normalize).sort(), [
    normalize(path.join(root, 'Profile 1', 'Cache')),
    normalize(path.join(root, 'Profile 2', 'Cache'))
  ]);
});

test('measures files recursively', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qingpan-measure-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'nested'));
  await fsp.writeFile(path.join(root, 'a.bin'), Buffer.alloc(128));
  await fsp.writeFile(path.join(root, 'nested', 'b.bin'), Buffer.alloc(256));
  const result = await measurePath(root);
  assert.equal(result.files, 2);
  assert.equal(result.bytes, 384);
});

test('rejects protected roots and targets outside a rule', () => {
  const env = {
    SystemDrive: 'C:', WINDIR: 'C:\\Windows', ProgramFiles: 'C:\\Program Files',
    PROGRAMDATA: 'C:\\ProgramData', USERPROFILE: 'C:\\Users\\Test', LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local'
  };
  const rule = { patterns: ['%LOCALAPPDATA%/Demo/Cache'] };
  assert.throws(() => assertSafeTarget('C:\\Windows', rule, env), /受保护/);
  assert.throws(() => assertSafeTarget('C:\\Users\\Test\\Documents', rule, env), /允许范围/);
  assert.equal(assertSafeTarget('C:\\Users\\Test\\AppData\\Local\\Demo\\Cache', rule, env), true);
});

test('resolves cleanup targets without passing Array.map metadata to path.resolve', () => {
  const targets = resolveUniqueTargets(['C:\\Temp\\one', 'C:\\Temp\\one', 'C:\\Temp\\two']);
  assert.deepEqual(targets, [path.resolve('C:\\Temp\\one'), path.resolve('C:\\Temp\\two')]);
});

test('accepts expanded wildcard segments but rejects paths that do not match the full rule', () => {
  assert.equal(globMatchesPath('C:\\Users\\Test\\User Data\\*\\Cache', 'C:\\Users\\Test\\User Data\\Profile 1\\Cache'), true);
  assert.equal(globMatchesPath('C:\\Users\\Test\\Packages\\MSTeams_*\\LocalCache', 'C:\\Users\\Test\\Packages\\MSTeams_8wekyb3d8bbwe\\LocalCache'), true);
  assert.equal(globMatchesPath('C:\\Users\\Test\\User Data\\*\\Cache', 'C:\\Users\\Test\\Documents\\Cache'), false);
  assert.equal(globMatchesPath('C:\\Users\\Test\\User Data\\*\\Cache', 'C:\\Users\\Test\\User Data\\Profile 1\\Cookies'), false);
});

test('cleans a selected rule end-to-end without the previous paths array error', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qingpan-clean-'));
  const cache = path.join(root, 'npm-cache');
  await fsp.mkdir(cache);
  await fsp.writeFile(path.join(cache, 'package.bin'), Buffer.alloc(321));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  t.after(async () => {
    if (previous == null) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
    await fsp.rm(root, { recursive: true, force: true });
  });
  const report = await cleanSelected(['npm-cache']);
  assert.equal(report.cleanedBytes, 321);
  assert.equal(report.cleanedFiles, 1);
  assert.deepEqual(await fsp.readdir(cache), []);
});

test('cleans a browser profile expanded from a wildcard rule', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'qingpan-browser-'));
  const cache = path.join(root, 'Google', 'Chrome', 'User Data', 'Profile 1', 'Cache');
  await fsp.mkdir(cache, { recursive: true });
  await fsp.writeFile(path.join(cache, 'data.bin'), Buffer.alloc(456));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = root;
  t.after(async () => {
    if (previous == null) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
    await fsp.rm(root, { recursive: true, force: true });
  });
  const report = await cleanSelected(['chrome-cache']);
  assert.equal(report.cleanedBytes, 456);
  assert.equal(report.cleanedFiles, 1);
  assert.equal(report.errors.length, 0);
});
