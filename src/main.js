const { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { scanAll, cleanSelected, getDriveInfo } = require('./core');
const { scanInstalledApps, launchUninstaller, publicApp, readRegistryApps, normalizeRegistryApps } = require('./apps');
const { listDrives, scanDisk, validateTrashFile } = require('./disk');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

let mainWindow;
const { createCacheScan } = require('./cache-scan');
const cacheScan = createCacheScan({ scanAll, getDriveInfo });
let cleanToken = null;
let appScanToken = null;
let installedAppCache = new Map();
let diskToken = null, diskResult = null, diskOwners = [], trashBusy = false;

async function selectedDrive(root) {
  const drive = (await listDrives()).find(d => d.root.toLowerCase() === String(root).toLowerCase());
  if (!drive) throw new Error('请选择一个可用的本地磁盘');
  return drive;
}

ipcMain.handle('disk:drives', () => listDrives());
ipcMain.handle('disk:scan', async (event, root, minMB) => {
  if (diskToken || trashBusy) throw new Error('磁盘任务正在进行中');
  if (![100, 500, 1024].includes(minMB)) throw new Error('文件大小筛选无效');
  const token = { cancelled: false };
  diskToken = token; diskResult = null;
  try {
    const drive = await selectedDrive(root);
    let ownerWarning = '';
    try { diskOwners = normalizeRegistryApps(await readRegistryApps(), process.env, null); }
    catch { diskOwners = []; ownerWarning = '软件归属读取失败，文件解释仅根据路径和类型推测。'; }
    diskResult = await scanDisk(drive.root, { minBytes: minMB * 1024 ** 2, cancelToken: token, owners: diskOwners,
      onProgress: p => { if (!event.sender.isDestroyed()) event.sender.send('disk:progress', p); } });
    diskResult.drive = await selectedDrive(root);
    diskResult.ownerWarning = ownerWarning;
    return diskResult;
  } finally { diskToken = null; }
});
ipcMain.handle('disk:cancel', () => { if (diskToken) diskToken.cancelled = true; });
ipcMain.handle('disk:trash', async (_event, ids) => {
  if (diskToken || trashBusy || !diskResult) throw new Error('请等待扫描完成后再清理');
  if (!Array.isArray(ids) || !ids.length || ids.length > 2000) throw new Error('请选择有效文件');
  trashBusy = true;
  try {
    const entries = [...new Set(ids)].map(id => diskResult.files.find(f => f.id === id));
    if (entries.some(f => !f || !f.canTrash)) throw new Error('所选文件已过期或不可直接清理');
    const answer = await dialog.showMessageBox(mainWindow, { type: 'warning', title: '移入回收站',
      message: `将 ${entries.length} 个文件移入回收站？`,
      detail: entries.slice(0, 8).map(f => f.path).join('\n') + '\n\n这会影响依赖这些文件的软件。回收站仍占用原磁盘空间，确认无误后需自行清空才能释放。若回收站操作失败，本程序不会改为永久删除。',
      buttons: ['取消', '移入回收站'], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return { cancelled: true, removed: [], errors: [] };
    const report = { removed: [], errors: [] };
    appendAudit({ action: 'large-files-trash-start', paths: entries.map(f => f.path) });
    for (const entry of entries) {
      try {
        const target = await validateTrashFile(entry, diskResult.root, diskOwners);
        await shell.trashItem(target);
        report.removed.push(entry.id);
      } catch (e) { report.errors.push({ path: entry.path, message: e.message }); }
    }
    diskResult.files = diskResult.files.filter(f => !report.removed.includes(f.id));
    try {
      appendAudit({ action: 'large-files-trash-result', report });
    } catch (error) {
      // Files have already moved: preserve the actual outcome, without retrying.
      report.auditWarning = `日志保存失败：${error.message}（本次回收站操作结果日志未写入）`;
    }
    return report;
  } finally { trashBusy = false; }
});

ipcMain.handle('system:cleanup', async (_event, action) => {
  if (action === 'storage') { await shell.openExternal('ms-settings:storagesense'); return; }
  if (action !== 'cleanmgr') throw new Error('未知的系统操作');
  // Interactive Windows UI: no /verylowdisk, no silent or automatic deletion.
  execFile(path.join(process.env.WINDIR, 'System32', 'cleanmgr.exe'), ['/d', process.env.SystemDrive || 'C:'], { windowsHide: false }, () => {});
});
ipcMain.handle('system:analyze', async () => {
  try {
    const { stdout } = await execute(path.join(process.env.WINDIR, 'System32', 'Dism.exe'), ['/English', '/Online', '/Cleanup-Image', '/AnalyzeComponentStore'], { windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024 });
    return { ok: true, text: stdout };
  } catch (e) { return { ok: false, text: e.stdout || e.message }; }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 660,
    backgroundColor: '#f4f6f9',
    show: false,
    title: '老君清',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f8fafc',
      symbolColor: '#344054',
      height: 44
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });

  const screenshotIndex = process.argv.indexOf('--screenshot');
  if (screenshotIndex >= 0) {
    const output = process.argv[screenshotIndex + 1] || path.join(process.cwd(), 'screenshot.png');
    mainWindow.webContents.once('did-finish-load', async () => {
      const script = process.argv.includes('--disk-screenshot')
        ? `new Promise(resolve => { switchView('disk'); const wait = setInterval(() => { const b = document.querySelector('#diskScan'); if (!b.disabled) { clearInterval(wait); b.click(); const done = setInterval(() => { if (!b.disabled) { clearInterval(done); resolve(); } }, 500); } }, 200); })`
        : process.argv.includes('--apps-screenshot')
        ? "document.querySelector('[data-view=software]').click(); document.querySelector('#scanAppsButton').click()"
        : "document.querySelector('#scanButton').click()";
      await mainWindow.webContents.executeJavaScript(script);
      setTimeout(async () => {
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(output, image.toPNG());
        if (process.argv.includes('--disk-screenshot')) {
          await mainWindow.webContents.executeJavaScript("document.querySelector('#diskFiles').scrollIntoView()");
          await new Promise(resolve => setTimeout(resolve, 300));
          fs.writeFileSync(output.replace('.png', '-files.png'), (await mainWindow.webContents.capturePage()).toPNG());
          await mainWindow.webContents.executeJavaScript("switchView('system'); document.querySelector('.main-content').scrollTop = 0");
          await new Promise(resolve => setTimeout(resolve, 300));
          fs.writeFileSync(output.replace('.png', '-system.png'), (await mainWindow.webContents.capturePage()).toPNG());
        }
        app.quit();
      }, 12000);
    });
  }
}

function appendAudit(entry) {
  const logPath = path.join(app.getPath('userData'), 'cleanup-audit.jsonl');
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
  return logPath;
}

ipcMain.handle('system:info', async () => ({
  drive: await getDriveInfo(),
  platform: process.platform,
  version: app.getVersion(),
  computerName: process.env.COMPUTERNAME || '这台电脑'
}));

ipcMain.handle('scan:start', (event, scanId) => {
  if (cleanToken) throw new Error('清理正在进行中，请等待清理退出后再扫描');
  return cacheScan.start(event, scanId);
});
ipcMain.handle('scan:cancel', (event, scanId) => cacheScan.cancel(event, scanId));

ipcMain.handle('clean:start', async (event, ids) => {
  if (cleanToken) throw new Error('清理正在进行中');
  if (cacheScan.busy) throw new Error('缓存扫描尚未退出，请等待扫描退出后再清理');
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) throw new Error('请选择有效的清理项');
  const uniqueIds = [...new Set(ids.filter((id) => typeof id === 'string'))];
  cleanToken = { cancelled: false };
  try {
  const report = await cleanSelected(uniqueIds, {
    cancelToken: cleanToken,
    onProgress: (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('clean:progress', progress);
    }
  });
  let audit = {};
  try {
    audit.auditPath = appendAudit({ action: 'clean', selectedIds: uniqueIds, report });
  } catch (error) {
    // Deletion already finished. Audit failure must not discard its report or
    // cause the caller to retry cleanup as though no files were removed.
    audit = { auditWarning: `日志保存失败：${error.message}（本次清理记录未写入）` };
  }
  return { ...report, ...audit, drive: await getDriveInfo() };
  } finally { cleanToken = null; }
});

ipcMain.handle('clean:cancel', () => {
  if (cleanToken) cleanToken.cancelled = true;
  return Boolean(cleanToken);
});

ipcMain.handle('apps:scan', async (event, root) => {
  if (appScanToken) appScanToken.cancelled = true;
  const token = { cancelled: false };
  appScanToken = token;
  try {
    const drive = root ? await selectedDrive(root) : null;
    const apps = await scanInstalledApps({
      drive: drive?.root || process.env.SystemDrive || 'C:',
      cancelToken: token,
      onProgress: (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('apps:progress', progress);
      }
    });
    if (token.cancelled) return { cancelled: true, apps: [] };
    installedAppCache = new Map(apps.map((item) => [item.id, item]));
    return { cancelled: false, apps: apps.map(publicApp), warning: apps.storeWarning || '', drive: await getDriveInfo(), scannedAt: new Date().toISOString() };
  } finally {
    if (appScanToken === token) appScanToken = null;
  }
});

ipcMain.handle('apps:uninstall', async (_event, id) => {
  if (typeof id !== 'string') throw new Error('软件标识无效');
  const target = installedAppCache.get(id);
  if (!target) throw new Error('软件列表已过期，请重新扫描');
  if (target.storeApp) {
    await shell.openExternal('ms-settings:appsfeatures');
    return { started: false, manage: true, name: target.name };
  }
  launchUninstaller(target);
  appendAudit({ action: 'uninstall-started', appId: id, appName: target.name, publisher: target.publisher });
  return { started: true, name: target.name };
});

ipcMain.handle('path:show', async (_event, target) => {
  if (typeof target !== 'string' || !path.isAbsolute(target)) return false;
  shell.showItemInFolder(target);
  return true;
});

ipcMain.handle('audit:show', async () => {
  const logPath = path.join(app.getPath('userData'), 'cleanup-audit.jsonl');
  if (fs.existsSync(logPath)) shell.showItemInFolder(logPath);
  else shell.openPath(app.getPath('userData'));
  return logPath;
});

app.whenReady().then(() => {
  nativeTheme.themeSource = 'light';
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
