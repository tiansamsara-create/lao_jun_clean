const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { measurePath, normalize } = require('./core');
const { expandEnvironment } = require('./rules');
const { describeApp } = require('./app-descriptions');

const execFileAsync = promisify(execFile);

const REGISTRY_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$roots = @(
  'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'Registry::HKEY_CURRENT_USER\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$result = foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root | ForEach-Object {
    $item = Get-ItemProperty -LiteralPath $_.PSPath
    [PSCustomObject]@{
      Key = $_.Name
      DisplayName = [string]$item.DisplayName
      DisplayVersion = [string]$item.DisplayVersion
      Publisher = [string]$item.Publisher
      InstallLocation = [string]$item.InstallLocation
      DisplayIcon = [string]$item.DisplayIcon
      EstimatedSize = $item.EstimatedSize
      UninstallString = [string]$item.UninstallString
      QuietUninstallString = [string]$item.QuietUninstallString
      SystemComponent = $item.SystemComponent
      ParentKeyName = [string]$item.ParentKeyName
      ReleaseType = [string]$item.ReleaseType
      WindowsInstaller = $item.WindowsInstaller
    }
  }
}
@($result) | ConvertTo-Json -Depth 3 -Compress
`;

function text(value) {
  return value == null ? '' : String(value).trim();
}

function numeric(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value.slice(2), 16);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stripIconIndex(value) {
  let result = text(value);
  if (result.startsWith('"')) {
    const end = result.indexOf('"', 1);
    if (end > 1) result = result.slice(1, end);
  } else {
    result = result.replace(/,\s*-?\d+\s*$/, '');
  }
  return expandEnvironment(result).trim().replace(/^"|"$/g, '');
}

function executableFromCommand(command) {
  const expanded = expandEnvironment(text(command));
  const quoted = expanded.match(/^"([^"]+\.(?:exe|com|bat|cmd))"/i);
  if (quoted) return quoted[1];
  const plain = expanded.match(/^([^\r\n]+?\.(?:exe|com|bat|cmd))(?=\s|$)/i);
  return plain ? plain[1] : '';
}

function isDirectory(value) {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

function inferLocation(raw) {
  const explicit = expandEnvironment(text(raw.InstallLocation)).replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
  if (explicit && isDirectory(explicit)) return { location: path.resolve(explicit), inferred: false };

  const icon = stripIconIndex(raw.DisplayIcon);
  if (icon && fs.existsSync(icon)) {
    const stats = fs.statSync(icon);
    const candidate = stats.isDirectory() ? icon : path.dirname(icon);
    if (isDirectory(candidate)) return { location: path.resolve(candidate), inferred: true };
  }

  const executable = executableFromCommand(raw.UninstallString);
  if (executable && fs.existsSync(executable)) {
    const candidate = path.dirname(executable);
    if (isDirectory(candidate)) return { location: path.resolve(candidate), inferred: true };
  }
  return { location: '', inferred: false };
}

function isMeasureSafe(location, env = process.env) {
  if (!location || !path.isAbsolute(location)) return false;
  const value = normalize(location);
  const blocked = [
    `${env.SystemDrive || 'C:'}\\`, env.WINDIR, env.ProgramFiles, env['ProgramFiles(x86)'],
    env.PROGRAMDATA, env.USERPROFILE, env.LOCALAPPDATA, env.APPDATA
  ].filter(Boolean).map(normalize);
  if (blocked.includes(value)) return false;
  const windowsRoot = env.WINDIR && normalize(env.WINDIR);
  if (windowsRoot && value.startsWith(`${windowsRoot}${path.sep}`)) return false;
  const windowsApps = env.ProgramFiles && normalize(path.join(env.ProgramFiles, 'WindowsApps'));
  if (windowsApps && (value === windowsApps || value.startsWith(`${windowsApps}${path.sep}`))) return false;
  return true;
}

function normalizeRegistryApps(rawEntries, env = process.env, selectedDrive = env.SystemDrive || 'C:') {
  const systemRoot = path.parse(`${env.SystemDrive || 'C:'}\\`).root.toLowerCase();
  const seen = new Map();
  for (const raw of rawEntries || []) {
    const name = text(raw.DisplayName);
    const uninstallString = text(raw.UninstallString);
    const releaseType = text(raw.ReleaseType).toLowerCase();
    if (!name || numeric(raw.SystemComponent) === 1 || text(raw.ParentKeyName)) continue;
    if (releaseType.includes('update') || releaseType.includes('hotfix') || /\b(KB\d{6,})\b/i.test(name)) continue;
    if (!uninstallString) continue;

    const { location, inferred } = inferLocation(raw);
    const explicitDrive = location ? path.parse(location).root.toLowerCase() : '';
    if (selectedDrive && explicitDrive && explicitDrive !== path.parse(`${selectedDrive.replace(/[\\/]+$/, '')}\\`).root.toLowerCase()) continue;
    const reportedBytes = Math.max(0, numeric(raw.EstimatedSize) * 1024);
    const dedupeKey = `${name.toLowerCase()}\0${text(raw.DisplayVersion).toLowerCase()}\0${uninstallString.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    const id = crypto.createHash('sha256').update(`${text(raw.Key)}\0${dedupeKey}`).digest('hex').slice(0, 20);
    seen.set(dedupeKey, {
      id,
      name,
      description: describeApp(name),
      version: text(raw.DisplayVersion),
      publisher: text(raw.Publisher) || '未知发布者',
      location,
      locationInferred: inferred,
      reportedBytes,
      measuredBytes: 0,
      size: reportedBytes,
      sizeSource: reportedBytes ? '系统报告' : '未知',
      uninstallable: true,
      uninstallString: expandEnvironment(uninstallString),
      quietUninstallString: expandEnvironment(text(raw.QuietUninstallString)),
      windowsInstaller: numeric(raw.WindowsInstaller) === 1,
      registryKey: text(raw.Key),
      onSystemDrive: !explicitDrive || explicitDrive === systemRoot,
      canMeasure: isMeasureSafe(location, env)
    });
  }
  return [...seen.values()];
}

async function readRegistryApps() {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', REGISTRY_SCRIPT
  ], { windowsHide: true, timeout: 30000, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' });
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function readStoreApps(drive) {
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-AppxPackage -ErrorAction Stop | Where-Object { -not $_.IsFramework -and -not $_.IsResourcePackage } | Select-Object Name,PackageFullName,Publisher,Version,InstallLocation,NonRemovable) | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30000, encoding: 'utf8', maxBuffer: 10 * 1024 ** 2 });
  const value = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(value) ? value : [value]).filter(x => x.InstallLocation && path.parse(x.InstallLocation).root.toLowerCase() === path.parse(drive.endsWith('\\') ? drive : `${drive}\\`).root.toLowerCase()).map(x => ({
    id: crypto.createHash('sha256').update(x.PackageFullName).digest('hex').slice(0, 20), name: x.Name, publisher: x.Publisher, version: x.Version,
    location: x.InstallLocation, locationInferred: false, canMeasure: true, size: 0, reportedBytes: 0, sizeSource: '未知',
    storeApp: true, uninstallable: !x.NonRemovable, description: describeApp(x.Name),
    uninstallString: '', registryKey: x.PackageFullName
  }));
}

async function scanInstalledApps({ onProgress = () => {}, cancelToken = { cancelled: false }, drive = process.env.SystemDrive || 'C:' } = {}) {
  onProgress({ current: 0, total: 1, app: '读取 Windows 软件列表' });
  const raw = await readRegistryApps();
  const apps = normalizeRegistryApps(raw, process.env, drive);
  try { apps.push(...await readStoreApps(drive)); } catch { apps.storeWarning = '无法读取商店应用，请在 Windows 已安装应用中查看。'; }
  const locationCounts = new Map();
  for (const item of apps) {
    if (item.location) {
      const key = normalize(item.location);
      locationCounts.set(key, (locationCounts.get(key) || 0) + 1);
    }
  }
  for (const item of apps) {
    if (item.location && locationCounts.get(normalize(item.location)) > 1) {
      item.canMeasure = false;
      item.sizeSource = item.reportedBytes ? '系统报告' : '共享目录';
    }
  }
  const measurable = apps.filter((item) => item.canMeasure);
  const locationCache = new Map();
  let cursor = 0;
  let completed = 0;

  const worker = async () => {
    while (!cancelToken.cancelled) {
      const index = cursor++;
      if (index >= measurable.length) return;
      const app = measurable[index];
      const key = normalize(app.location);
      let result = locationCache.get(key);
      if (!result) {
        const pending = measurePath(app.location, cancelToken);
        locationCache.set(key, pending);
        result = pending;
      }
      const measured = await result;
      app.measuredBytes = measured.bytes;
      app.fileCount = measured.files;
      if (measured.bytes > 0) {
        app.size = measured.bytes;
        app.sizeSource = app.locationInferred ? '目录估算' : '实际测量';
      }
      completed += 1;
      onProgress({ current: completed, total: measurable.length, app: app.name });
    }
  };

  if (measurable.length) await Promise.all(Array.from({ length: Math.min(4, measurable.length) }, worker));
  return apps.sort((a, b) => b.size - a.size || a.name.localeCompare(b.name, 'zh-CN'));
}

function publicApp(app) {
  const { uninstallString, quietUninstallString, registryKey, ...safe } = app;
  return safe;
}

function launchUninstaller(app) {
  if (!app || !app.uninstallString) throw new Error('这个软件没有提供卸载程序');
  let command = app.uninstallString.trim();
  if (!command || command.length > 4096 || /[\r\n\0]/.test(command)) throw new Error('卸载命令无效');
  if (/^msiexec(?:\.exe)?\s+\/i(?=\s*{)/i.test(command)) command = command.replace(/\/i(?=\s*{)/i, '/x');
  const child = spawn(command, [], {
    shell: true,
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
  return true;
}

module.exports = {
  readRegistryApps,
  normalizeRegistryApps,
  scanInstalledApps,
  launchUninstaller,
  publicApp,
  inferLocation,
  isMeasureSafe
};
