(() => {
  let drives = [], result = null, busy = false, pageSize = 100, systemDrive = 'C:';
  const selected = new Set();
  const escape = escapeHtml;
  const ui = id => document.getElementById(id);
  function setBusy(value) {
    busy = value;
    ['diskScan', 'diskDrive', 'diskThreshold', 'diskTrash', 'systemScan'].forEach(id => { ui(id).disabled = value; });
    ui('diskStop').classList.toggle('hidden', !value);
    ui('diskStop').disabled = false;
    ui('diskStop').textContent = '停止扫描';
    updateSelection();
  }
  function updateSelection() {
    const files = result?.files.filter(f => selected.has(f.id)) || [];
    ui('diskSelection').textContent = `已选 ${files.length} 个文件 · ${formatBytes(files.reduce((sum, f) => sum + f.size, 0))}`;
    ui('diskTrash').disabled = busy || files.length === 0;
  }
  function renderFiles() {
    const query = ui('diskSearch').value.trim().toLowerCase();
    const files = (result?.files || []).filter(f => `${f.path} ${f.type} ${f.owner}`.toLowerCase().includes(query));
    ui('diskCount').textContent = result ? `${result.cancelled ? '部分结果 · ' : ''}找到 ${result.largeCount} 个大文件，保留最大的 ${result.files.length} 个；当前匹配 ${files.length} 个` : '扫描后按体积从大到小显示';
    ui('diskFiles').innerHTML = files.slice(0, pageSize).map(f => `<article class="disk-file">
      <input type="checkbox" data-file-id="${f.id}" aria-label="选择 ${escape(f.name)}" ${selected.has(f.id) ? 'checked' : ''} ${!f.canTrash || busy ? 'disabled' : ''}>
      <div><h4>${escape(f.name)}</h4><div class="disk-path">${escape(f.path)}</div><p><b>${escape(f.type)}</b> · ${escape(f.explanation)}</p><small>归属：${escape(f.owner)} · ${f.canTrash ? '需自行确认' : '仅查看 / 使用软件或系统管理'}</small></div>
      <aside><strong>${formatBytes(f.size)}</strong><button class="secondary-button" data-file-path="${escape(f.path)}">定位</button></aside>
    </article>`).join('') || '<p class="disk-note">没有匹配的大文件。请查看目录占用，或降低阈值后重新扫描。</p>';
    ui('diskMore').classList.toggle('hidden', files.length <= pageSize);
    updateSelection();
  }
  function renderOverview() {
    if (!result) return;
    const drive = result.drive;
    ui('diskStats').innerHTML = `<article><span>磁盘实际已用</span><strong>${formatBytes(drive.used)}</strong></article><article><span>扫描文件合计（逻辑大小）</span><strong>${formatBytes(result.bytes)}</strong></article><article><span>磁盘可用</span><strong>${formatBytes(drive.free)}</strong></article>`;
    ui('diskOverview').innerHTML = result.buckets.slice(0, 8).map(b => `<div class="disk-bucket"><span>${escape(b.name)}</span><b>${formatBytes(b.bytes)}</b><progress max="${result.bytes || 1}" value="${b.bytes}"></progress></div>`).join('');
    ui('diskDirectoryBox').classList.remove('hidden');
    ui('diskDirectories').innerHTML = result.directories.map(d => `<div class="disk-dir-row"><button data-file-path="${escape(d.path)}">${escape(d.path)}</button><b>${formatBytes(d.bytes)}</b></div>`).join('');
    ui('diskStatus').textContent = `${result.cancelled ? '扫描已停止，以下为部分结果。' : '扫描完成。'}检查 ${result.fileCount.toLocaleString()} 个文件、${result.folders.toLocaleString()} 个目录；${result.inaccessible} 处无法读取，跳过 ${result.links} 个链接，去重 ${result.hardlinks} 个硬链接。${result.sizeNote} ${result.ownerWarning || ''}`;
    if (result.root.toLowerCase().startsWith(systemDrive.toLowerCase())) ui('systemSummary').textContent = `本次系统盘目录排行：${result.buckets.slice(0, 5).map(b => `${b.name} ${formatBytes(b.bytes)}`).join('；')}。这是文件逻辑大小，硬链接归属会受扫描顺序影响，不能当作可清理量。`;
  }
  async function scan() {
    if (busy || !ui('diskDrive').value) return;
    selected.clear(); result = null; pageSize = 100;
    ui('diskStats').innerHTML = ''; ui('diskOverview').innerHTML = ''; ui('diskFiles').innerHTML = '';
    ui('diskDirectoryBox').classList.add('hidden'); ui('diskMore').classList.add('hidden');
    setBusy(true); ui('diskStatus').textContent = '正在准备所选磁盘扫描…';
    try {
      result = await window.qingpan.scanDisk(ui('diskDrive').value, Number(ui('diskThreshold').value));
      renderOverview();
    } catch (error) { ui('diskStatus').textContent = `扫描失败：${error.message}`; }
    finally { setBusy(false); renderFiles(); }
  }
  ui('diskScan').addEventListener('click', scan);
  ui('diskStop').addEventListener('click', async () => { ui('diskStop').disabled = true; ui('diskStop').textContent = '正在停止…'; await window.qingpan.cancelDisk(); });
  ui('diskSearch').addEventListener('input', () => { pageSize = 100; renderFiles(); });
  ui('diskMore').addEventListener('click', () => { pageSize += 100; renderFiles(); });
  ui('diskFiles').addEventListener('change', event => {
    const id = event.target.dataset.fileId;
    if (id) { event.target.checked ? selected.add(id) : selected.delete(id); updateSelection(); }
  });
  ui('diskView').addEventListener('click', event => {
    const button = event.target.closest('[data-file-path]');
    if (button) window.qingpan.showPath(button.dataset.filePath);
  });
  ui('diskTrash').addEventListener('click', async () => {
    setBusy(true); ui('diskStop').classList.add('hidden');
    try {
      const response = await window.qingpan.trashFiles([...selected]);
      if (!response.cancelled) {
        result.files = result.files.filter(f => !response.removed.includes(f.id));
        selected.clear();
        ui('diskStatus').textContent = `已移入回收站 ${response.removed.length} 个文件，失败 ${response.errors.length} 个。回收站仍占用磁盘；目录统计保留扫描时数值。`;
        if (response.errors.length) ui('diskStatus').textContent += ` ${response.errors.slice(0, 3).map(e => `${e.path}：${e.message}`).join('；')}`;
        if (response.auditWarning) ui('diskStatus').textContent += ` 操作结果已保留。${response.auditWarning}`;
      }
    } catch (error) { showToast(error.message); }
    finally { setBusy(false); renderFiles(); }
  });
  window.qingpan.onDiskProgress(p => {
    ui('diskStatus').textContent = `正在扫描 ${ui('diskDrive').value} · 已检查 ${p.files.toLocaleString()} 个文件 / ${formatBytes(p.bytes)} · 无权限或不可读 ${p.inaccessible} 处 · ${p.path}`;
  });
  ui('systemScan').addEventListener('click', () => {
    const root = drives.find(d => d.root.toLowerCase().startsWith(systemDrive.toLowerCase()))?.root || drives[0]?.root;
    if (!root) return showToast('没有可扫描的磁盘');
    ui('diskDrive').value = root; switchView('disk'); scan();
  });
  document.querySelectorAll('[data-system-action]').forEach(button => button.addEventListener('click', async () => {
    try { await window.qingpan.systemCleanup(button.dataset.systemAction); } catch (error) { showToast(error.message); }
  }));
  ui('systemAnalyze').addEventListener('click', async () => {
    ui('systemAnalyze').disabled = true;
    ui('systemOutput').classList.remove('hidden');
    ui('systemOutput').textContent = '正在进行只读分析，可能需要几分钟…';
    try {
      const response = await window.qingpan.analyzeSystem();
      ui('systemOutput').textContent = (response.ok ? '官方分析结果：\n' : '分析未完成。若提示 740，请关闭程序并右键以管理员身份运行后重试。\n') + response.text;
    } catch (error) { ui('systemOutput').textContent = error.message; }
    finally { ui('systemAnalyze').disabled = false; }
  });
  (async () => {
    ui('diskScan').disabled = true;
    try {
      drives = await window.qingpan.listDrives();
      systemDrive = (await window.qingpan.getSystemInfo()).drive.drive;
      const options = drives.map(d => `<option value="${escape(d.root)}">${escape(d.root)} ${escape(d.label || '')} · 可用 ${formatBytes(d.free)}</option>`).join('');
      ui('diskDrive').innerHTML = options; ui('softwareDrive').innerHTML = options;
      ui('diskScan').disabled = !drives.length;
    } catch (error) { ui('diskStatus').textContent = `磁盘列表读取失败：${error.message}`; }
  })();
})();
