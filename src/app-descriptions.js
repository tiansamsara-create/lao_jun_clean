function describeApp(name) {
  const rules = [
    [/office|microsoft 365|word|excel/i, 'Office 办公套件，用于文档、表格和演示；卸载前确认工作需要。'],
    [/visual studio|vscode|cursor|qoder|lingma|通义灵码/i, '编程编辑器或开发环境；扩展、索引和用户缓存常在安装目录之外。'],
    [/codex|chatgpt|claude/i, 'AI 助手或开发工具；会话和设置属于用户数据，清缓存时应保留。'],
    [/nvidia|amd|intel.*driver|realtek/i, '硬件驱动或控制面板；可能关系到显示、声音或网络，不建议为省空间直接卸载。'],
    [/visual c\+\+|\.net|webview|runtime|redistributable/i, '共享运行环境，其他软件可能依赖；即使不认识也不应随意卸载。'],
    [/steam|epic|xbox|游戏|launcher/i, '游戏或游戏平台；游戏库可能存放在其他目录，安装目录大小不包含全部游戏。'],
    [/chrome|edge|firefox|夸克/i, '网页浏览器；缓存、账号和用户资料通常存放在 AppData。'],
    [/mysql|postgres|sql server/i, '数据库或数据库工具；卸载前先备份业务数据。'],
    [/微信|qq|teams|discord|钉钉|飞书|slack/i, '聊天与协作软件；聊天附件、历史记录可能占用大量用户目录空间。'],
    [/网盘|onedrive|dropbox/i, '云盘同步软件；同步文件可能位于安装目录之外，删除文件可能同步到云端。'],
    [/adobe|premiere|photoshop|after effects|剪映|必剪/i, '创作或视频编辑工具；媒体缓存、预览和项目文件需分别处理。'],
    [/docker|wsl|virtualbox|vmware/i, '虚拟化或容器工具；虚拟磁盘可能很大，应通过原软件清理或压缩。']
  ];
  return (rules.find(([pattern]) => pattern.test(name))?.[1] || 'Windows 登记的应用；用途未可靠识别，请根据发布者和安装位置判断。') + '（按名称规则说明）';
}
module.exports = { describeApp };
