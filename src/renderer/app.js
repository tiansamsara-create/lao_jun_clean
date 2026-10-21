const state = {
  items: [],
  selected: new Set(),
  expanded: new Set(),
  category: '全部',
  search: '',
  busy: false,
  scanned: false,
  view: 'cleaner',
  apps: [],
  appsScanned: false,
  appsBusy: false,
  softwareSearch: '',
  softwareSort: 'size',
  uninstallTarget: null
};

const $ = (selector) => document.querySelector(selector);
const els = {
  machineName: $('#machineName'), lastScan: $('#lastScan'), heroTitle: $('#heroTitle'), heroSub: $('#heroSub'),
  scanButton: $('#scanButton'), scanHint: $('#scanHint'), driveRing: $('#driveRing'), driveLetter: $('#driveLetter'),
  driveFree: $('#driveFree'), driveUsed: $('#driveUsed'), driveTotal: $('#driveTotal'), categoryNav: $('#categoryNav'),
  allCount: $('#allCount'), resultCount: $('#resultCount'), resultsSummary: $('#resultsSummary'), searchInput: $('#searchInput'),
  selectSafe: $('#selectSafe'), progressWrap: $('#progressWrap'), progressBar: $('#progressBar'), progressText: $('#progressText'),
  emptyState: $('#emptyState'), appList: $('#appList'), actionBar: $('#actionBar'), selectedCount: $('#selectedCount'),
  selectedSize: $('#selectedSize'), clearSelection: $('#clearSelection'), cleanButton: $('#cleanButton'),
  confirmModal: $('#confirmModal'), confirmCount: $('#confirmCount'), confirmSize: $('#confirmSize'), understandCheck: $('#understandCheck'),
  confirmClean: $('#confirmClean'), resultModal: $('#resultModal'), resultMessage: $('#resultMessage'), cleanedSize: $('#cleanedSize'),
  cleanedFiles: $('#cleanedFiles'), skippedFiles: $('#skippedFiles'), toast: $('#toast'), openAudit: $('#openAudit'),
  cleanerView: $('#cleanerView'), softwareView: $('#softwareView'), categoryLabel: $('#categoryLabel'),
  scanAppsButton: $('#scanAppsButton'), softwareCount: $('#softwareCount'), softwareTotal: $('#softwareTotal'),
  softwareResultCount: $('#softwareResultCount'), softwareSummaryText: $('#softwareSummaryText'), softwareSearch: $('#softwareSearch'),
  softwareSort: $('#softwareSort'), appsProgressWrap: $('#appsProgressWrap'), appsProgressBar: $('#appsProgressBar'),
  appsProgressText: $('#appsProgressText'), softwareEmpty: $('#softwareEmpty'), softwareTable: $('#softwareTable'),
  softwareRows: $('#softwareRows'), uninstallModal: $('#uninstallModal'), uninstallName: $('#uninstallName'),
  uninstallPublisher: $('#uninstallPublisher'), uninstallSize: $('#uninstallSize'), confirmUninstall: $('#confirmUninstall')
};

const categoryIcons = { '系统': '▦', '浏览器': '◉', '聊天与办公': '⌁', '开发工具': '⌘', '游戏': '◇', '图形与创作': '✦', '深度清理': '⬡', 'AI 与大缓存': '◎', '其他软件': '＋' };

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function appInitial(name) {
  const trimmed = name.trim();
  return /[\u4e00-\u9fff]/.test(trimmed[0] || '') ? trimmed[0] : (trimmed.match(/[A-Za-z0-9]/)?.[0] || 'A').toUpperCase();
}

function colorFor(name) {
  let hash = 0;
  for (const char of name) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 6;
}

function updateDrive(drive) {
  if (!drive) return;
  els.driveLetter.textContent = drive.drive || 'C:';
  els.driveFree.textContent = formatBytes(drive.free);
  els.driveUsed.textContent = formatBytes(drive.used);
  els.driveTotal.textContent = formatBytes(drive.total);
  const usage = drive.total ? Math.round((drive.used / drive.total) * 360) : 0;
  els.driveRing.style.setProperty('--usage', `${usage}deg`);
}

function detectedItems() { return state.items.filter((item) => item.detected); }

function filteredItems() {
  const query = state.search.toLowerCase();
  return detectedItems().filter((item) => {
    const inCategory = state.category === '全部' || item.category === state.category;
    const matches = !query || `${item.app} ${item.item} ${item.description}`.toLowerCase().includes(query);
    return inCategory && matches;
  });
}

function groupsFor(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.category}::${item.app}`;
    if (!groups.has(key)) groups.set(key, { app: item.app, category: item.category, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()].sort((a, b) => {
    const aBytes = a.items.reduce((sum, item) => sum + item.bytes, 0);
    const bBytes = b.items.reduce((sum, item) => sum + item.bytes, 0);
    return bBytes - aBytes || a.app.localeCompare(b.app, 'zh-CN');
  });
}

function renderCategories() {
  const counts = new Map();
  for (const item of detectedItems()) counts.set(item.category, (counts.get(item.category) || 0) + 1);
  els.allCount.textContent = detectedItems().length;
  els.categoryNav.querySelectorAll('.nav-item:not([data-category="全部"])').forEach((node) => node.remove());
  for (const [category, count] of counts) {
    const button = document.createElement('button');
    button.className = `nav-item${state.category === category ? ' active' : ''}`;
    button.dataset.category = category;
    button.innerHTML = `<span class="nav-icon">${categoryIcons[category] || '•'}</span><span>${escapeHtml(category)}</span><b>${count}</b>`;
    els.categoryNav.appendChild(button);
  }
  els.categoryNav.querySelector('[data-category="全部"]').classList.toggle('active', state.category === '全部');
}

function renderResults() {
  const items = filteredItems();
  const groups = groupsFor(items);
  els.resultCount.textContent = groups.length;
  els.resultsSummary.textContent = state.scanned
    ? `共检测到 ${groupsFor(detectedItems()).length} 个软件、${detectedItems().reduce((sum, item) => sum + item.files, 0).toLocaleString()} 个缓存文件`
    : '扫描后，检测到的软件会显示在这里';

  if (!state.scanned || !groups.length) {
    els.appList.classList.add('hidden');
    els.emptyState.classList.remove('hidden');
    els.emptyState.querySelector('h4').textContent = state.scanned ? '没有匹配的项目' : '等待第一次扫描';
    els.emptyState.querySelector('p').textContent = state.scanned ? '换一个分类或搜索词试试。' : '会按软件分类显示体积、文件数、风险提示和具体位置。';
    updateSelection();
    return;
  }

  els.emptyState.classList.add('hidden');
  els.appList.classList.remove('hidden');
  els.appList.innerHTML = groups.map((group) => {
    const key = `${group.category}::${group.app}`;
    const checkedCount = group.items.filter((item) => state.selected.has(item.id)).length;
    const bytes = group.items.reduce((sum, item) => sum + item.bytes, 0);
    const files = group.items.reduce((sum, item) => sum + item.files, 0);
    const colorIndex = colorFor(group.app);
    return `<article class="app-card${state.expanded.has(key) ? ' expanded' : ''}" data-group="${escapeHtml(key)}">
      <div class="app-head" data-toggle-group="${escapeHtml(key)}">
        <label class="check-wrap" title="选择该软件的全部项目"><input class="group-check" type="checkbox" data-check-group="${escapeHtml(key)}" ${checkedCount === group.items.length ? 'checked' : ''}></label>
        <div class="app-icon icon-color-${colorIndex}">${escapeHtml(appInitial(group.app))}</div>
        <div class="app-meta"><strong>${escapeHtml(group.app)}</strong><span>${escapeHtml(group.category)} · ${files.toLocaleString()} 个文件 · ${group.items.length} 个清理项</span></div>
        <div class="app-size"><strong>${formatBytes(bytes)}</strong><span>可清理</span></div>
        <span class="chevron">⌄</span>
      </div>
      <div class="item-list">
        ${group.items.map((item) => `<div class="clean-item">
          <label class="check-wrap"><input class="item-check" type="checkbox" data-id="${escapeHtml(item.id)}" ${state.selected.has(item.id) ? 'checked' : ''}></label>
          <div class="item-copy"><strong>${escapeHtml(item.item)}</strong><p>${escapeHtml(item.description)}</p></div>
          <span class="risk-badge risk-${item.risk}">${item.risk === 'safe' ? '安全清理' : '确认后清理'}</span>
          <span class="item-size">${formatBytes(item.bytes)}</span>
          <button class="folder-button" data-path="${escapeHtml(item.paths[0] || '')}" title="在资源管理器中查看">
            <svg viewBox="0 0 24 24"><path d="M3.5 6.5h6l2 2h9v10h-17z"/></svg>
          </button>
        </div>`).join('')}
      </div>
    </article>`;
  }).join('');

  for (const group of groups) {
    const key = `${group.category}::${group.app}`;
    const checkbox = els.appList.querySelector(`[data-check-group="${CSS.escape(key)}"]`);
    const selected = group.items.filter((item) => state.selected.has(item.id)).length;
    if (checkbox) checkbox.indeterminate = selected > 0 && selected < group.items.length;
  }
  updateSelection();
}

function updateSelection() {
  const selectedItems = detectedItems().filter((item) => state.selected.has(item.id));
  const bytes = selectedItems.reduce((sum, item) => sum + item.bytes, 0);
  els.selectedCount.textContent = selectedItems.length;
  els.selectedSize.textContent = formatBytes(bytes);
  els.actionBar.classList.toggle('hidden', !state.scanned || state.view !== 'cleaner');
  els.cleanButton.disabled = selectedItems.length === 0 || state.busy;
}

function switchView(view) {
  state.view = view;
  els.cleanerView.classList.toggle('hidden', view !== 'cleaner');
  els.softwareView.classList.toggle('hidden', view !== 'software');
  $('#diskView').classList.toggle('hidden', view !== 'disk');
  $('#systemView').classList.toggle('hidden', view !== 'system');
  els.categoryNav.classList.toggle('hidden', view !== 'cleaner');
  els.categoryLabel.classList.toggle('hidden', view !== 'cleaner');
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  updateSelection();
}

function filteredSoftware() {
  const query = state.softwareSearch.toLowerCase();
  const result = state.apps.filter((item) => !query || `${item.name} ${item.publisher} ${item.version} ${item.location}`.toLowerCase().includes(query));
  result.sort((a, b) => {
    if (state.softwareSort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (state.softwareSort === 'publisher') return a.publisher.localeCompare(b.publisher, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN');
    return b.size - a.size || a.name.localeCompare(b.name, 'zh-CN');
  });
  return result;
}

function renderSoftware() {
  const apps = filteredSoftware();
  const total = state.apps.reduce((sum, item) => sum + (item.size || 0), 0);
  els.softwareCount.textContent = state.appsScanned ? state.apps.length : '—';
  els.softwareTotal.textContent = state.appsScanned ? formatBytes(total) : '—';
  els.softwareResultCount.textContent = apps.length;
  els.softwareSummaryText.textContent = state.appsScanned
    ? `已识别 ${state.apps.length} 个所选磁盘或位置未登记的软件；不含全部用户数据，共享目录可能重复`
    : '按大小排序，先找出最值得处理的软件';
  if (!state.appsScanned || !apps.length) {
    els.softwareEmpty.classList.remove('hidden');
    els.softwareTable.classList.add('hidden');
    els.softwareEmpty.querySelector('h4').textContent = state.appsScanned ? '没有匹配的软件' : '还没有扫描软件';
    els.softwareEmpty.querySelector('p').textContent = state.appsScanned ? '换一个搜索词或排序方式试试。' : '扫描时间取决于安装目录大小，通常需要十几秒到几分钟。';
    return;
  }
  els.softwareEmpty.classList.add('hidden');
  els.softwareTable.classList.remove('hidden');
  els.softwareRows.innerHTML = apps.map((app) => {
    const colorIndex = colorFor(app.name);
    const location = app.location || '安装位置未登记';
    const size = app.size > 0 ? formatBytes(app.size) : '未知';
    return `<div class="software-row">
      <div class="software-name-cell">
        <div class="app-icon icon-color-${colorIndex}">${escapeHtml(appInitial(app.name))}</div>
        <div><strong title="${escapeHtml(app.name)}">${escapeHtml(app.name)}</strong><span>${app.storeApp ? 'Microsoft Store 应用' : app.fileCount ? `${Number(app.fileCount).toLocaleString()} 个文件` : 'Windows 已安装程序'}</span><p class="software-explanation">${escapeHtml(app.description || '用途未识别，请核对发布者。')}</p></div>
      </div>
      <div class="software-detail"><strong title="${escapeHtml(app.publisher)}">${escapeHtml(app.publisher)}</strong><span>${escapeHtml(app.version || '版本未知')}</span></div>
      <div class="software-path" ${app.location ? `data-software-path="${escapeHtml(app.location)}" title="点击打开：${escapeHtml(app.location)}"` : `title="Windows 没有登记安装位置"`}>${escapeHtml(location)}</div>
      <div class="software-size"><strong>${size}</strong><span>${escapeHtml(app.sizeSource)}</span></div>
      <button class="uninstall-button" data-uninstall="${escapeHtml(app.id)}">${app.storeApp ? '系统管理' : '卸载'}</button>
    </div>`;
  }).join('');
}

function setAppsBusy(busy) {
  state.appsBusy = busy;
  $('#softwareDrive').disabled = busy;
  els.scanAppsButton.disabled = busy;
  els.softwareSearch.disabled = busy;
  els.softwareSort.disabled = busy;
  els.appsProgressWrap.classList.toggle('hidden', !busy);
  els.scanAppsButton.querySelector('span').textContent = busy ? '正在测量软件占用…' : state.appsScanned ? '重新扫描软件' : '扫描已安装软件';
}

async function runAppsScan() {
  if (state.appsBusy) return;
  setAppsBusy(true);
  els.appsProgressBar.style.width = '2%';
  els.appsProgressText.textContent = '正在读取 Windows 软件列表…';
  try {
    const result = await window.qingpan.scanApps($('#softwareDrive').value);
    if (result.cancelled) return;
    state.apps = result.apps;
    state.appsScanned = true;
    updateDrive(result.drive);
    renderSoftware();
    if (result.warning) showToast(result.warning);
  } catch (error) {
    showToast(`软件扫描失败：${error.message}`);
  } finally {
    setAppsBusy(false);
  }
}

function openUninstall(app) {
  if (app.storeApp) {
    window.qingpan.uninstallApp(app.id)
      .then(() => showToast(`请在 Windows 已安装应用中查找 ${app.name}，由系统决定是否允许卸载`))
      .catch(error => showToast(`无法打开系统管理：${error.message}`));
    return;
  }
  state.uninstallTarget = app;
  els.uninstallName.textContent = app.name;
  els.uninstallPublisher.textContent = app.publisher;
  els.uninstallSize.textContent = app.size > 0 ? formatBytes(app.size) : '占用未知';
  els.uninstallModal.classList.remove('hidden');
}

async function startUninstall() {
  if (!state.uninstallTarget) return;
  els.confirmUninstall.disabled = true;
  try {
    const result = await window.qingpan.uninstallApp(state.uninstallTarget.id);
    els.uninstallModal.classList.add('hidden');
    showToast(result.manage ? `请在 Windows 已安装应用中查找 ${result.name}` : `已启动 ${result.name} 的卸载程序；完成后请重新扫描`);
  } catch (error) {
    showToast(`无法启动卸载：${error.message}`);
  } finally {
    els.confirmUninstall.disabled = false;
    state.uninstallTarget = null;
  }
}

function setBusy(busy, mode = 'scan') {
  $('#stopClean').classList.toggle('hidden', !busy || mode !== 'clean');
  $('#stopClean').disabled = false;
  $('#stopClean').textContent = '停止清理';
  els.clearSelection.disabled = busy;
  state.busy = busy;
  els.scanButton.disabled = busy && mode !== 'scan';
  els.searchInput.disabled = busy;
  els.selectSafe.disabled = busy;
  els.cleanButton.disabled = busy || state.selected.size === 0;
  els.progressWrap.classList.toggle('hidden', !busy);
  if (busy) {
    els.scanButton.querySelector('span').textContent = mode === 'scan' ? '停止扫描' : '正在清理…';
    els.progressBar.style.width = '2%';
  } else {
    els.scanButton.querySelector('span').textContent = state.scanned ? '重新扫描' : '开始扫描';
    els.progressWrap.classList.add('hidden');
  }
}

const cacheScanController = createScanController({
  api: window.qingpan,
  onBusy(busy) {
    setBusy(busy, 'scan');
    if (busy) {
      els.progressText.textContent = '正在准备扫描…';
      els.scanHint.textContent = '只读取文件大小，不修改任何内容';
    } else {
      updateSelection();
    }
  },
  onComplete(result) {
    state.items = result.items;
    state.scanned = true;
    state.selected = new Set(result.items.filter((item) => item.detected && item.selected && item.bytes > 0).map((item) => item.id));
    state.expanded = new Set(groupsFor(result.items.filter((item) => item.detected)).slice(0, 2).map((group) => `${group.category}::${group.app}`));
    const total = detectedItems().reduce((sum, item) => sum + item.bytes, 0);
    els.heroTitle.textContent = total ? `发现 ${formatBytes(total)} 可清理空间` : 'C 盘现在很干净';
    els.heroSub.textContent = total ? '下面按软件列出了扫描结果。黄色项目不会默认选择，请确认影响后再勾选。' : '没有发现已知的缓存和临时文件。你可以稍后再来扫描。';
    els.lastScan.textContent = '刚刚扫描';
    els.scanHint.textContent = `已检查 ${result.items.length} 条安全规则`;
    updateDrive(result.drive);
    renderCategories();
    renderResults();
  },
  onCancelled() {
    els.scanHint.textContent = state.scanned
      ? '扫描已停止，保留上次完整结果和选择'
      : '扫描已停止，尚未完成扫描，可重新开始';
  },
  onError(error) {
    els.scanHint.textContent = state.scanned
      ? '扫描失败，保留上次完整结果和选择，可重新扫描'
      : '扫描失败，可重新开始';
    showToast(`扫描失败：${error.message}`);
  },
  onStopping() {
    els.scanButton.disabled = true;
    els.scanButton.querySelector('span').textContent = '正在停止…';
    els.progressText.textContent = '正在停止扫描，等待当前任务退出…';
    els.scanHint.textContent = '停止不会清理文件，也不会替换上次完整结果';
  },
  onCancelError(error) {
    els.scanButton.disabled = false;
    els.scanButton.querySelector('span').textContent = '停止扫描';
    els.progressText.textContent = '扫描尚未退出，可再次点击停止扫描';
    els.scanHint.textContent = '停止未完成；仍在等待扫描退出，可重试停止';
    showToast(`停止扫描未完成：${error.message}`);
  },
  onProgress({ current, total, app }) {
    els.progressBar.style.width = `${Math.max(2, Math.round((current / total) * 100))}%`;
    els.progressText.textContent = `正在检查 ${app} · ${current}/${total}`;
  }
});

async function runScan() {
  if (cacheScanController.busy) return cacheScanController.stop();
  if (state.busy) return;
  return cacheScanController.start();
}

async function runClean() {
  const ids = [...state.selected];
  if (!ids.length || state.busy) return;
  els.confirmModal.classList.add('hidden');
  setBusy(true, 'clean');
  els.progressText.textContent = '正在安全地清理所选项目…';
  try {
    const report = await window.qingpan.clean(ids);
    updateDrive(report.drive);
    els.cleanedSize.textContent = formatBytes(report.cleanedBytes);
    els.cleanedFiles.textContent = report.cleanedFiles.toLocaleString();
    els.skippedFiles.textContent = report.skippedFiles.toLocaleString();
    $('#resultTitle').textContent = report.cancelled ? '清理已停止' : '清理完成';
    els.resultMessage.textContent = report.cancelled ? '已停止安排新的删除任务。下方显示停止前已完成的清理。' : report.errors.length
      ? `清理已完成。有 ${report.skippedFiles} 个正在使用或无权限的文件被安全跳过。`
      : '所选缓存已清理完成。软件下次启动时可能会重建少量缓存。';
    if (report.auditWarning) {
      els.resultMessage.textContent += ` 清理结果已保留。${report.auditWarning}`;
    }
    els.resultModal.classList.remove('hidden');
    state.selected.clear();
    // Apply measured deletions immediately; a full rescan of 150k files is optional.
    for (const result of report.items) {
      const item = state.items.find((entry) => entry.id === result.id);
      if (item) { item.bytes = Math.max(0, item.bytes - result.bytes); item.files = Math.max(0, item.files - result.files); }
    }
    renderResults();
    els.heroTitle.textContent = `本次已清理 ${formatBytes(report.cleanedBytes)}`;
    els.lastScan.textContent = report.cancelled ? '清理已停止' : '刚刚清理';
    els.scanHint.textContent = '列表已扣除本次删除量，重新扫描可获取最新占用';
  } catch (error) {
    showToast(`清理失败：${error.message}`);
  } finally {
    setBusy(false);
    updateSelection();
  }
}

async function runScanAfterClean() {
  // If reused, go through the same task ownership/cancellation path.
  return runScan();
}

function openConfirm() {
  const selectedItems = detectedItems().filter((item) => state.selected.has(item.id));
  if (!selectedItems.length) return;
  els.confirmCount.textContent = selectedItems.length;
  els.confirmSize.textContent = formatBytes(selectedItems.reduce((sum, item) => sum + item.bytes, 0));
  els.understandCheck.checked = false;
  els.confirmClean.disabled = true;
  els.confirmModal.classList.remove('hidden');
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3500);
}

els.scanButton.addEventListener('click', runScan);
$('#stopClean').addEventListener('click', async () => {
  $('#stopClean').disabled = true;
  $('#stopClean').textContent = '正在停止…';
  try { await window.qingpan.cancelClean(); } catch (error) { showToast(error.message); }
});
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
els.searchInput.addEventListener('input', (event) => { state.search = event.target.value.trim(); renderResults(); });
els.categoryNav.addEventListener('click', (event) => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  state.category = button.dataset.category;
  renderCategories();
  renderResults();
});
els.appList.addEventListener('click', (event) => {
  const itemCheck = event.target.closest('.item-check');
  if (itemCheck) {
    if (itemCheck.checked) state.selected.add(itemCheck.dataset.id); else state.selected.delete(itemCheck.dataset.id);
    renderResults();
    return;
  }
  const groupCheck = event.target.closest('.group-check');
  if (groupCheck) {
    event.stopPropagation();
    const key = groupCheck.dataset.checkGroup;
    const separator = key.indexOf('::');
    const category = key.slice(0, separator);
    const app = key.slice(separator + 2);
    const items = detectedItems().filter((item) => item.category === category && item.app === app);
    const shouldSelect = !items.every((item) => state.selected.has(item.id));
    for (const item of items) shouldSelect ? state.selected.add(item.id) : state.selected.delete(item.id);
    renderResults();
    return;
  }
  const folder = event.target.closest('[data-path]');
  if (folder) {
    event.stopPropagation();
    if (folder.dataset.path) window.qingpan.showPath(folder.dataset.path);
    return;
  }
  const head = event.target.closest('[data-toggle-group]');
  if (head) {
    const key = head.dataset.toggleGroup;
    state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key);
    renderResults();
  }
});
els.selectSafe.addEventListener('click', () => {
  for (const item of detectedItems()) {
    if (item.risk === 'safe' && item.bytes > 0) state.selected.add(item.id);
    else state.selected.delete(item.id);
  }
  renderResults();
});
els.clearSelection.addEventListener('click', () => { state.selected.clear(); renderResults(); });
els.cleanButton.addEventListener('click', openConfirm);
els.understandCheck.addEventListener('change', () => { els.confirmClean.disabled = !els.understandCheck.checked; });
els.confirmClean.addEventListener('click', runClean);
document.querySelectorAll('[data-close-modal]').forEach((button) => button.addEventListener('click', () => els.confirmModal.classList.add('hidden')));
document.querySelectorAll('[data-close-result]').forEach((button) => button.addEventListener('click', () => els.resultModal.classList.add('hidden')));
els.openAudit.addEventListener('click', () => window.qingpan.showAudit());
els.scanAppsButton.addEventListener('click', runAppsScan);
els.softwareSearch.addEventListener('input', (event) => { state.softwareSearch = event.target.value.trim(); renderSoftware(); });
els.softwareSort.addEventListener('change', (event) => { state.softwareSort = event.target.value; renderSoftware(); });
els.softwareRows.addEventListener('click', (event) => {
  const uninstall = event.target.closest('[data-uninstall]');
  if (uninstall) {
    const app = state.apps.find((item) => item.id === uninstall.dataset.uninstall);
    if (app) openUninstall(app);
    return;
  }
  const location = event.target.closest('[data-software-path]');
  if (location) window.qingpan.showPath(location.dataset.softwarePath);
});
els.confirmUninstall.addEventListener('click', startUninstall);
document.querySelectorAll('[data-close-uninstall]').forEach((button) => button.addEventListener('click', () => {
  els.uninstallModal.classList.add('hidden');
  state.uninstallTarget = null;
}));

window.qingpan.onScanProgress((progress) => cacheScanController.progress(progress));
window.qingpan.onCleanProgress(({ current, total, app, item, path, cleanedFiles = 0, cleanedBytes = 0, skippedFiles = 0 }) => {
  els.progressBar.style.width = `${Math.round((current / total) * 100)}%`;
  els.progressText.textContent = `${app} · ${current}/${total} 项完成`;
  els.progressText.title = path || '';
  els.scanHint.textContent = `${item || ''} · 已删除 ${cleanedFiles.toLocaleString()} 个文件 / ${formatBytes(cleanedBytes)} · 跳过 ${skippedFiles}`;
});
window.qingpan.onAppsProgress(({ current, total, app }) => {
  const percent = total ? Math.max(2, Math.round((current / total) * 100)) : 2;
  els.appsProgressBar.style.width = `${percent}%`;
  els.appsProgressText.textContent = current === 0 ? app : `正在测量 ${app} · ${current}/${total}`;
});

(async function init() {
  try {
    const info = await window.qingpan.getSystemInfo();
    els.machineName.textContent = info.computerName;
    updateDrive(info.drive);
  } catch { showToast('无法读取磁盘信息'); }
})();
