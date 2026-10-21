const fs = require('node:fs').promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const within = (root, target) => { const rel = path.relative(path.resolve(root), path.resolve(target)); return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };

async function listDrives() {
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @([IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -in @('Fixed','Removable') } | ForEach-Object { [pscustomobject]@{ root=$_.Name; label=$_.VolumeLabel; total=$_.TotalSize; free=$_.AvailableFreeSpace } }) | ConvertTo-Json -Compress`;
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
  const result = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(result) ? result : [result]).map(d => ({ ...d, used: d.total - d.free }));
}

function explainFile(target, owners = [], env = process.env) {
  const name = path.basename(target).toLowerCase();
  const lower = target.toLowerCase();
  const ext = path.extname(name);
  const appDataOwner = target.match(/[\\/]AppData[\\/](?:Local|Roaming|LocalLow)[\\/]([^\\/]+)/i)?.[1];
  const owner = owners.find(app => app.location && app.canMeasure && within(app.location, target));
  let type = '其他文件', explanation = '用途尚未识别，请根据完整路径和所属软件确认。', canTrash = false;
  const systemNames = { 'pagefile.sys': '虚拟内存分页文件，由 Windows 管理；不要手动删除。', 'swapfile.sys': 'Windows 应用交换文件，由系统管理。', 'hiberfil.sys': '休眠与快速启动文件；关闭休眠会影响这些功能，不作为普通垃圾删除。' };
  if (systemNames[name]) return { type: '系统保留', explanation: systemNames[name], canTrash, owner: 'Windows' };
  if (env.WINDIR && within(env.WINDIR, target)) {
    explanation = /[\\/]winsxs[\\/]/i.test(target) ? 'Windows 组件仓库，包含更新和共享组件；通过系统磁盘清理维护，不能手动删。' : /[\\/]installer[\\/]/i.test(target) ? 'Windows 安装/修复缓存；删除会破坏软件修复、更新或卸载。' : 'Windows 系统文件或维护数据，请通过系统清理工具处理。';
    return { type: '系统文件', explanation, canTrash, owner: 'Windows' };
  }
  if (/[\\/](system volume information|\$recycle.bin|recovery|\$windows\.~bt|windows.old|\$extend|\$boot|\$winreagent)[\\/]/i.test(target) || name.startsWith('$')) return { type: '系统维护', explanation: '系统恢复、回收站或文件系统维护数据；使用 Windows 管理工具。', canTrash, owner: 'Windows' };
  if (['.vhd', '.vhdx', '.vmdk', '.qcow2'].includes(ext)) return { type: '虚拟磁盘', explanation: '可能包含 Docker、WSL 或虚拟机的全部系统和数据；应在对应软件内管理或压缩。', canTrash, owner: owner?.name || '虚拟机 / WSL / Docker（按类型推测）' };
  if (owner || [env.ProgramFiles, env['ProgramFiles(x86)'], env.PROGRAMDATA].filter(Boolean).some(root => within(root, target)) || /[\\/](steamapps|windowsapps)[\\/]/i.test(target)) return { type: '软件或游戏数据', explanation: '安装目录或共享应用数据；建议卸载或使用软件内的清理功能，单独删除可能损坏软件。', canTrash, owner: owner?.name || '根据目录推测' };
  if (/[\\/]appdata[\\/]/i.test(target)) return { type: '应用数据', explanation: '可能是聊天记录、数据库、下载缓存或设置。大并不代表无用，请到所属软件内管理。', canTrash, owner: owner?.name || `${appDataOwner || '应用数据目录'}（根据目录推测）` };
  if (['.gguf', '.safetensors', '.pt', '.pth', '.onnx'].includes(ext)) { type = 'AI 模型'; explanation = '模型权重；确认不再使用且可以重新下载后再清理。'; canTrash = true; }
  else if (['.zip', '.7z', '.rar', '.tar', '.gz', '.iso', '.msi'].includes(ext) || (ext === '.exe' && /[\\/]downloads[\\/]/i.test(target))) { type = '压缩包 / 安装包'; explanation = '归档、安装包或光盘镜像；确认已经安装、解压且无需保留后可移入回收站。'; canTrash = true; }
  else if (['.mp4', '.mkv', '.avi', '.mov', '.wav', '.flac', '.mp3', '.webm'].includes(ext)) { type = '视频 / 音频'; explanation = '媒体或录制内容，不属于垃圾；确认有备份或不再需要后再清理。'; canTrash = true; }
  else if (['.pdf', '.docx', '.xlsx', '.pptx', '.psd', '.blend', '.bak', '.db', '.sqlite', '.pst', '.ost'].includes(ext)) { type = '文档 / 项目 / 数据库'; explanation = '可能含工作成果、备份、邮件或数据库；优先备份和在原软件中管理。'; }
  else if (['.dll', '.sys', '.exe', '.pak', '.bin', '.dat'].includes(ext)) { type = '程序 / 数据文件'; explanation = '可能是软件运行所需的数据，不能只凭扩展名判断可删。'; }
  else if (['.log', '.dmp', '.tmp'].includes(ext)) { type = '日志 / 临时文件'; explanation = '按扩展名推测为诊断或临时内容；先确认原软件已关闭，且无需用于故障排查。'; canTrash = true; }
  return { type, explanation, canTrash, owner: owner?.name || '未识别（解释基于路径和扩展名）' };
}

// Counts every file, including small files, so software caches do not disappear
// from the space overview. Large-file list is bounded separately.
async function scanDisk(root, { minBytes = 100 * 1024 ** 2, limit = 2000, cancelToken = {}, onProgress = () => {}, owners = [] } = {}) {
  root = path.resolve(root);
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('不能扫描目录链接');
  owners = [...owners].sort((a, b) => (b.location?.length || 0) - (a.location?.length || 0));
  const queue = [root], buckets = new Map(), directories = new Map(), seen = new Set();
  const result = { root, files: [], buckets: [], directories: [], bytes: 0, fileCount: 0, folders: 0, inaccessible: 0, links: 0, hardlinks: 0, largeCount: 0, minBytes, cancelled: false, sizeNote: '逻辑文件大小，硬链接仅计一次；压缩、稀疏文件、权限限制和系统保留空间可能造成与磁盘已用量不一致。' };
  let cursor = 0, active = 0, currentPath = root;
  const timer = setInterval(() => onProgress({ files: result.fileCount, folders: result.folders, bytes: result.bytes, path: currentPath, inaccessible: result.inaccessible }), 350);
  async function visit(dir) {
    currentPath = dir;
    let entries;
    let directoryBytes = 0;
    try {
      if ((await fs.lstat(dir)).isSymbolicLink()) { result.links++; return; }
      entries = await fs.readdir(dir, { withFileTypes: true });
      result.folders++;
    } catch { result.inaccessible++; return; }
    for (const entry of entries) {
      if (cancelToken.cancelled) break;
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { result.links++; continue; }
      if (entry.isDirectory()) { queue.push(target); continue; }
      if (!entry.isFile()) continue;
      let stats;
      try { stats = await fs.lstat(target); } catch { result.inaccessible++; continue; }
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      if (stats.nlink > 1 && stats.ino) {
        const key = `${stats.dev}:${stats.ino}`;
        if (seen.has(key)) { result.hardlinks++; continue; }
        seen.add(key);
      }
      result.bytes += stats.size; result.fileCount++;
      directoryBytes += stats.size;
      if (stats.size >= minBytes) {
        result.largeCount++;
        result.files.push({ id: randomUUID(), path: target, name: entry.name, size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino, dev: stats.dev, ...explainFile(target, owners) });
        if (result.files.length > limit * 2) result.files = result.files.sort((a, b) => b.size - a.size).slice(0, limit);
      }
    }
    // Aggregate once per directory, instead of repeating five path joins for
    // every tiny package-manager file.
    if (directoryBytes) {
      const relative = path.relative(root, dir);
      const parts = relative ? relative.split(path.sep) : [];
      const bucket = parts[0] || '根目录文件';
      buckets.set(bucket, (buckets.get(bucket) || 0) + directoryBytes);
      for (let depth = 1; depth <= Math.min(parts.length, 5); depth++) {
        const key = path.join(root, ...parts.slice(0, depth));
        directories.set(key, (directories.get(key) || 0) + directoryBytes);
      }
    }
  }
  try {
    await new Promise(resolve => {
      function pump() {
        while (!cancelToken.cancelled && active < 12 && cursor < queue.length) {
          const dir = queue[cursor]; queue[cursor++] = null; active++;
          visit(dir).finally(() => { active--; pump(); });
        }
        if (!active && (cancelToken.cancelled || cursor === queue.length)) resolve();
      }
      pump();
    });
  } finally { clearInterval(timer); }
  result.cancelled = Boolean(cancelToken.cancelled);
  result.files = result.files.sort((a, b) => b.size - a.size).slice(0, limit);
  result.buckets = [...buckets].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes);
  result.directories = [...directories].map(([path, bytes]) => ({ path, bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, 100);
  return result;
}

async function validateTrashFile(item, root, owners = []) {
  if (!item || !within(root, item.path) || path.resolve(root) === path.resolve(item.path)) throw new Error('文件不在本次扫描范围内');
  if (!item.canTrash || !explainFile(item.path, owners).canTrash) throw new Error('受保护文件，请使用系统或软件管理功能');
  // Check every ancestor, not just the leaf, to reject junction swaps.
  let current = path.resolve(item.path);
  while (true) {
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) throw new Error('路径包含链接，请重新扫描');
    if (current === path.resolve(item.path) && (!stats.isFile() || stats.size !== item.size || stats.mtimeMs !== item.mtimeMs || stats.ino !== item.ino || stats.dev !== item.dev)) throw new Error('文件在扫描后已变化，请重新扫描');
    if (current === path.resolve(root)) break;
    current = path.dirname(current);
  }
  return item.path;
}

module.exports = { listDrives, scanDisk, explainFile, within, validateTrashFile };
