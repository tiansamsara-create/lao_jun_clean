const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { scanDisk, explainFile, validateTrashFile } = require('../src/disk');
const { getRules } = require('../src/core');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'laojun-disk-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('single-root scan accounts small files, deduplicates hardlinks and excludes linked destinations', async t => {
  const root = await fixture(t), disk = path.join(root, 'disk'), other = path.join(root, 'other');
  await fs.mkdir(disk); await fs.mkdir(other);
  await fs.writeFile(path.join(disk, 'movie.mp4'), Buffer.alloc(200));
  await fs.link(path.join(disk, 'movie.mp4'), path.join(disk, 'movie-link.mp4'));
  await fs.writeFile(path.join(disk, 'small.txt'), Buffer.alloc(30));
  await fs.writeFile(path.join(other, 'outside.mp4'), Buffer.alloc(500));
  await fs.symlink(other, path.join(disk, 'junction'), 'junction');
  const r = await scanDisk(disk, { minBytes: 100 });
  assert.equal(r.bytes, 230); assert.equal(r.hardlinks, 1); assert.equal(r.links, 1);
  assert.equal(r.files.length, 1); assert.equal(r.fileCount, 2);
  assert.equal(r.files[0].size, 200);
});

test('protected Windows, installed software and virtual disks cannot be trashed', () => {
  const env = { WINDIR: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', PROGRAMDATA: 'C:\\ProgramData' };
  for (const target of ['C:\\Windows\\Installer\\setup.msi', 'C:\\pagefile.sys', 'D:\\vm.vhdx', 'C:\\$WinREAgent\\Backup\\recovery.zip', 'C:\\Program Files\\App\\movie.mp4']) {
    assert.equal(explainFile(target, [], env).canTrash, false, target);
  }
  assert.equal(explainFile('D:\\Apps\\Example\\media.mp4', [{ name: 'Example', location: 'D:\\Apps\\Example', canMeasure: true }], env).canTrash, false);
  assert.equal(explainFile('D:\\Downloads\\old.zip', [], env).canTrash, true);
});

test('deletion revalidation rejects changed, outside-root and replaced-junction files', async t => {
  const root = await fs.mkdtemp(path.join(process.cwd(), 'trash-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const disk = path.join(root, 'disk'), outside = path.join(root, 'outside');
  await fs.mkdir(disk); await fs.mkdir(outside);
  const media = path.join(disk, 'media'); await fs.mkdir(media);
  await fs.writeFile(path.join(media, 'movie.mp4'), '1234');
  const r = await scanDisk(disk, { minBytes: 1 });
  let item = r.files[0];
  assert.equal(item.canTrash, true);
  assert.equal(await validateTrashFile(item, disk), item.path);
  await assert.rejects(validateTrashFile({ ...item, canTrash: true }, outside), /范围/);
  await fs.writeFile(item.path, 'modified-longer');
  await assert.rejects(validateTrashFile(item, disk), /变化/);
  item = (await scanDisk(disk, { minBytes: 1 })).files[0];
  await fs.rename(media, path.join(root, 'saved-media'));
  await fs.writeFile(path.join(outside, 'movie.mp4'), 'modified-longer');
  await fs.symlink(outside, media, 'junction');
  await assert.rejects(validateTrashFile(item, disk), /变化|链接/);
  assert.equal(await fs.readFile(path.join(outside, 'movie.mp4'), 'utf8'), 'modified-longer');
});

test('cancelled scan returns explicitly partial results', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.zip'), 'data');
  const r = await scanDisk(root, { cancelToken: { cancelled: true }, minBytes: 1 });
  assert.equal(r.cancelled, true); assert.equal(r.fileCount, 0);
});

test('servicing and rollback directories are no longer directly deletable cleanup rules', async () => {
  const rules = await getRules();
  for (const id of ['windows-old', 'windows-update-downloads', 'delivery-optimization', 'recycle-bin', 'windows-upgrade-leftovers']) assert.equal(rules.some(r => r.id === id), false);
});
