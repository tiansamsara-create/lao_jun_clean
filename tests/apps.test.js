const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const { normalizeRegistryApps, isMeasureSafe, publicApp } = require('../src/apps');

test('normalizes uninstall entries, filters updates, and keeps uninstall command private', async (t) => {
  const installDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qingpan-app-'));
  t.after(() => fsp.rm(installDir, { recursive: true, force: true }));
  const drive = path.parse(installDir).root.replace(/[\\/]$/, '');
  const env = {
    ...process.env,
    SystemDrive: drive,
    WINDIR: `${drive}\\Windows`,
    ProgramFiles: `${drive}\\Program Files`,
    'ProgramFiles(x86)': `${drive}\\Program Files (x86)`,
    PROGRAMDATA: `${drive}\\ProgramData`,
    USERPROFILE: `${drive}\\Users\\Test`,
    LOCALAPPDATA: `${drive}\\Users\\Test\\AppData\\Local`,
    APPDATA: `${drive}\\Users\\Test\\AppData\\Roaming`
  };
  const apps = normalizeRegistryApps([
    { Key: 'app', DisplayName: 'Example App', DisplayVersion: '1.2', Publisher: 'Example', InstallLocation: installDir, EstimatedSize: 1024, UninstallString: 'uninstall.exe' },
    { Key: 'update', DisplayName: 'Security Update KB1234567', EstimatedSize: 999, UninstallString: 'remove.exe' },
    { Key: 'hidden', DisplayName: 'Hidden Component', SystemComponent: 1, UninstallString: 'remove.exe' }
  ], env);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, 'Example App');
  assert.equal(apps[0].reportedBytes, 1024 * 1024);
  assert.equal(publicApp(apps[0]).uninstallString, undefined);
});

test('does not recursively measure Windows system directories', () => {
  const env = {
    SystemDrive: 'C:', WINDIR: 'C:\\Windows', ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)', PROGRAMDATA: 'C:\\ProgramData',
    USERPROFILE: 'C:\\Users\\Test', LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    APPDATA: 'C:\\Users\\Test\\AppData\\Roaming'
  };
  assert.equal(isMeasureSafe('C:\\Windows\\System32', env), false);
  assert.equal(isMeasureSafe('C:\\Program Files\\Example App', env), true);
});
