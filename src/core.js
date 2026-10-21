const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const { staticRules, expandEnvironment } = require('./rules');
const { deleteContents } = require('./delete-engine');
const { createHash } = require('node:crypto');

const WILDCARD = /[*?]/;
const CACHE_NAMES = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache'];
const DISCOVERY_DENY = new Set(['Microsoft', 'Packages', 'Programs', 'Temp', 'ConnectedDevicesPlatform', 'Comms', 'Publishers']);

function normalize(value) {
  return path.resolve(value).toLowerCase().replace(/[\\/]+$/, '');
}

function hasWildcard(value) {
  return WILDCARD.test(value);
}

function wildcardRegex(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${escaped}$`, 'i');
}

async function pathExists(value) {
  try { await fsp.access(value); return true; } catch { return false; }
}

async function expandPattern(rawPattern, env = process.env) {
  const expanded = path.resolve(expandEnvironment(rawPattern, env));
  if (!hasWildcard(expanded)) return (await pathExists(expanded)) ? [expanded] : [];

  const parsed = path.parse(expanded);
  const relative = expanded.slice(parsed.root.length);
  const parts = relative.split(path.sep).filter(Boolean);
  let candidates = [parsed.root];

  for (const part of parts) {
    const next = [];
    if (!hasWildcard(part)) {
      for (const base of candidates) {
        const candidate = path.join(base, part);
        if (await pathExists(candidate)) next.push(candidate);
      }
    } else {
      const matcher = wildcardRegex(part);
      for (const base of candidates) {
        try {
          const entries = await fsp.readdir(base, { withFileTypes: true });
          for (const entry of entries) {
            if (matcher.test(entry.name)) next.push(path.join(base, entry.name));
          }
        } catch { /* missing or inaccessible */ }
      }
    }
    candidates = next;
    if (!candidates.length) break;
  }
  return candidates;
}

function isReparse(stats) {
  return stats.isSymbolicLink();
}

async function measurePath(target, cancelToken = { cancelled: false }) {
  let bytes = 0;
  let files = 0;
  const samples = [];
  const stack = [target];

  while (stack.length && !cancelToken.cancelled) {
    const current = stack.pop();
    let stats;
    try { stats = await fsp.lstat(current); } catch { continue; }
    if (isReparse(stats)) continue;
    if (stats.isFile()) {
      bytes += stats.size;
      files += 1;
      if (samples.length < 4) samples.push(current);
      continue;
    }
    if (!stats.isDirectory()) continue;
    try {
      const entries = await fsp.readdir(current);
      for (const name of entries) stack.push(path.join(current, name));
    } catch { /* access denied or locked */ }
  }
  return { bytes, files, samples };
}

async function findDiscoveredRules(knownPatterns, env = process.env) {
  const roots = [env.APPDATA, env.LOCALAPPDATA].filter(Boolean);
  const known = new Set();
  for (const pattern of knownPatterns) {
    if (!hasWildcard(pattern)) known.add(normalize(expandEnvironment(pattern, env)));
  }

  const rules = [];
  const seen = new Set();
  for (const root of roots) {
    let apps = [];
    try { apps = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const appDir of apps) {
      if (!appDir.isDirectory() || appDir.isSymbolicLink() || DISCOVERY_DENY.has(appDir.name)) continue;
      const appRoot = path.join(root, appDir.name);
      const found = [];
      for (const cacheName of CACHE_NAMES) {
        const cachePath = path.join(appRoot, cacheName);
        const key = normalize(cachePath);
        if (!known.has(key) && !seen.has(key) && await pathExists(cachePath)) {
          found.push(cachePath);
          seen.add(key);
        }
      }
      if (!found.length) continue;
      const slug = createHash('sha256').update(normalize(appRoot)).digest('hex').slice(0, 24);
      rules.push({
        id: `discovered-${slug}`,
        app: appDir.name,
        category: '其他软件',
        item: '自动发现的缓存',
        description: '检测到通用 Electron/Chromium 缓存目录；请确认软件名称后再选择。',
        risk: 'review',
        selected: false,
        patterns: found,
        discovered: true
      });
    }
  }
  return rules;
}

async function getRules(env = process.env) {
  const knownPatterns = staticRules.flatMap((rule) => rule.patterns);
  const discovered = await findDiscoveredRules(knownPatterns, env);
  // Servicing stores and recovery data must be handled by Windows, not unlink.
  const nativeOnly = new Set(['windows-update-downloads', 'delivery-optimization', 'windows-upgrade-leftovers', 'windows-old', 'recycle-bin']);
  return [...staticRules.filter(rule => !nativeOnly.has(rule.id)), ...discovered];
}

async function scanRule(rule, cancelToken) {
  const paths = [];
  const unique = new Set();
  for (const pattern of rule.patterns) {
    for (const match of await expandPattern(pattern)) {
      const key = normalize(match);
      if (!unique.has(key)) { unique.add(key); paths.push(match); }
    }
  }
  let bytes = 0;
  let files = 0;
  const samples = [];
  for (const target of paths) {
    const result = await measurePath(target, cancelToken);
    bytes += result.bytes;
    files += result.files;
    samples.push(...result.samples.slice(0, Math.max(0, 4 - samples.length)));
  }
  return { ...rule, paths, bytes, files, samples, detected: paths.length > 0 };
}

async function scanAll({ onProgress = () => {}, cancelToken = { cancelled: false } } = {}) {
  const rules = await getRules();
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (!cancelToken.cancelled) {
      const index = cursor++;
      if (index >= rules.length) return;
      const result = await scanRule(rules[index], cancelToken);
      results[index] = result;
      onProgress({ current: index + 1, total: rules.length, app: result.app });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, rules.length) }, worker));
  return results.filter(Boolean);
}

function protectedRoots(env = process.env) {
  return [
    env.SystemDrive && `${env.SystemDrive}\\`,
    env.WINDIR,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.PROGRAMDATA,
    env.USERPROFILE
  ].filter(Boolean).map(normalize);
}

function assertSafeTarget(target, rule, env = process.env) {
  const resolved = normalize(target);
  if (!path.isAbsolute(target)) throw new Error('拒绝非绝对路径');
  if (protectedRoots(env).includes(resolved)) throw new Error('拒绝清理受保护的系统根目录');
  const allowed = rule.patterns.some((pattern) => globMatchesPath(expandEnvironment(pattern, env), resolved));
  if (!allowed) throw new Error('目标不在清理规则允许范围内');
  return true;
}

function globMatchesPath(pattern, target) {
  const normalizedPattern = normalize(pattern);
  let source = '^';
  for (const char of normalizedPattern) {
    if (char === '*') source += '[^\\\\/]*';
    else if (char === '?') source += '[^\\\\/]';
    else if ('\\^$+.|()[]{}'.includes(char)) source += `\\${char}`;
    else source += char;
  }
  source += '$';
  return new RegExp(source, 'i').test(normalize(target));
}


async function cleanSelected(ids, { onProgress = () => {}, cancelToken = { cancelled: false } } = {}) {
  const ruleMap = new Map((await getRules()).map((rule) => [rule.id, rule]));
  const report = { cleanedBytes: 0, cleanedFiles: 0, skippedFiles: 0, errors: [], items: [] };
  let current = 0;
  for (const id of ids) {
    if (cancelToken.cancelled) break;
    const rule = ruleMap.get(id);
    if (!rule) continue;
    const beforeBytes = report.cleanedBytes;
    const beforeFiles = report.cleanedFiles;
    let currentPath = '';
    const emit = () => onProgress({ current, total: ids.length, app: rule.app, item: rule.item, path: currentPath, cleanedFiles: report.cleanedFiles, cleanedBytes: report.cleanedBytes, skippedFiles: report.skippedFiles });
    emit();
    const heartbeat = setInterval(emit, 250);
    try {
    const targets = [];
    for (const pattern of rule.patterns) targets.push(...await expandPattern(pattern));
    for (const target of resolveUniqueTargets(targets)) {
      if (cancelToken.cancelled) break;
      try {
        assertSafeTarget(target, rule);
      } catch (error) {
        report.errors.push(`${target}: ${error.message}`);
        report.skippedFiles += 1;
        continue;
      }
      await deleteContents(target, report, { cancelToken, onProgress: (value) => { currentPath = value; } });
    }
    } finally { clearInterval(heartbeat); }
    report.items.push({ id, app: rule.app, bytes: report.cleanedBytes - beforeBytes, files: report.cleanedFiles - beforeFiles });
    current += 1;
    emit();
  }
  report.cancelled = Boolean(cancelToken.cancelled);
  return report;
}

function resolveUniqueTargets(targets) {
  return [...new Set(targets.map((value) => path.resolve(value)))];
}

async function getDriveInfo() {
  const drive = process.env.SystemDrive || path.parse(os.homedir()).root.replace(/[\\/]$/, '');
  try {
    const stats = await fsp.statfs(`${drive}\\`, { bigint: true });
    const total = Number(stats.blocks * stats.bsize);
    const free = Number(stats.bavail * stats.bsize);
    return { drive, total, free, used: total - free };
  } catch {
    return { drive, total: 0, free: 0, used: 0 };
  }
}

module.exports = {
  expandPattern,
  measurePath,
  scanAll,
  scanRule,
  cleanSelected,
  getDriveInfo,
  assertSafeTarget,
  normalize,
  getRules,
  resolveUniqueTargets,
  globMatchesPath
};
