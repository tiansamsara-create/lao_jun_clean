const path = require('node:path');

const P = (value) => value.replaceAll('/', path.sep);

/**
 * Cleaning rules intentionally target rebuildable caches and logs only.
 * Cookies, sessions, passwords, history, messages and downloaded files are excluded.
 */
const staticRules = [
  {
    id: 'user-temp', app: 'Windows', category: '系统', item: '用户临时文件',
    description: '应用留下的临时文件；正在使用的文件会自动跳过。', risk: 'safe', selected: true,
    patterns: ['%TEMP%']
  },
  {
    id: 'windows-temp', app: 'Windows', category: '系统', item: '系统临时文件',
    description: 'Windows 和安装程序的临时文件，部分内容需要管理员权限。', risk: 'review', selected: false, admin: true,
    patterns: ['%WINDIR%/Temp']
  },
  {
    id: 'crash-dumps', app: 'Windows', category: '系统', item: '崩溃转储与错误报告',
    description: '程序崩溃后用于诊断的报告，不影响正常使用。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/CrashDumps', '%LOCALAPPDATA%/Microsoft/Windows/WER/ReportArchive', '%LOCALAPPDATA%/Microsoft/Windows/WER/ReportQueue']
  },
  {
    id: 'thumbnail-cache', app: '文件资源管理器', category: '系统', item: '缩略图缓存',
    description: '图片和视频缩略图，会在浏览文件夹时自动重建。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/Microsoft/Windows/Explorer/thumbcache_*.db', '%LOCALAPPDATA%/Microsoft/Windows/Explorer/iconcache_*.db']
  },
  {
    id: 'd3d-cache', app: 'Windows 图形系统', category: '系统', item: 'DirectX 着色器缓存',
    description: '图形着色器缓存，游戏或应用下次启动时可能短暂重建。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/D3DSCache']
  },

  {
    id: 'chrome-cache', app: 'Google Chrome', category: '浏览器', item: '网页缓存',
    description: '仅网页资源缓存，不删除历史记录、Cookie、密码或登录状态。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/Google/Chrome/User Data/*/Cache', '%LOCALAPPDATA%/Google/Chrome/User Data/*/Code Cache', '%LOCALAPPDATA%/Google/Chrome/User Data/*/GPUCache', '%LOCALAPPDATA%/Google/Chrome/User Data/*/Service Worker/CacheStorage']
  },
  {
    id: 'edge-cache', app: 'Microsoft Edge', category: '浏览器', item: '网页缓存',
    description: '仅网页资源缓存，不删除历史记录、Cookie、密码或登录状态。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/Microsoft/Edge/User Data/*/Cache', '%LOCALAPPDATA%/Microsoft/Edge/User Data/*/Code Cache', '%LOCALAPPDATA%/Microsoft/Edge/User Data/*/GPUCache', '%LOCALAPPDATA%/Microsoft/Edge/User Data/*/Service Worker/CacheStorage']
  },
  {
    id: 'brave-cache', app: 'Brave', category: '浏览器', item: '网页缓存',
    description: '仅网页资源缓存，不删除历史记录、Cookie、密码或登录状态。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data/*/Cache', '%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data/*/Code Cache', '%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data/*/GPUCache', '%LOCALAPPDATA%/BraveSoftware/Brave-Browser/User Data/*/Service Worker/CacheStorage']
  },
  {
    id: 'firefox-cache', app: 'Mozilla Firefox', category: '浏览器', item: '网页缓存',
    description: '只清理 cache2，不触碰 places.sqlite，因此书签和历史记录都保留。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/Mozilla/Firefox/Profiles/*/cache2']
  },

  {
    id: 'wechat-cache', app: '微信', category: '聊天与办公', item: '程序缓存与日志',
    description: '只清理可重建的 Cache、Code Cache、GPUCache 和日志；聊天记录与接收文件不在范围内。', risk: 'safe', selected: true,
    patterns: ['%APPDATA%/Tencent/WeChat/XPlugin/Plugins/*/Cache', '%APPDATA%/Tencent/WeChat/log', '%LOCALAPPDATA%/Tencent/WeChat/Cache', '%APPDATA%/WeChat/Cache', '%APPDATA%/WeChat/Code Cache', '%APPDATA%/WeChat/GPUCache', '%APPDATA%/WeChat/logs']
  },
  {
    id: 'qq-cache', app: 'QQ', category: '聊天与办公', item: '程序缓存与日志',
    description: '只清理 NTQQ 的网页、代码、显卡缓存和日志，不触碰聊天数据库与接收文件。', risk: 'safe', selected: true,
    patterns: ['%APPDATA%/Tencent/QQ/Cache', '%APPDATA%/Tencent/QQ/Code Cache', '%APPDATA%/Tencent/QQ/GPUCache', '%APPDATA%/Tencent/QQ/logs', '%LOCALAPPDATA%/Tencent/QQ/Cache']
  },
  {
    id: 'teams-cache', app: 'Microsoft Teams', category: '聊天与办公', item: '应用缓存',
    description: 'Teams 的网页与图形缓存，不清理登录凭据。', risk: 'safe', selected: true,
    patterns: ['%APPDATA%/Microsoft/Teams/Cache', '%APPDATA%/Microsoft/Teams/Code Cache', '%APPDATA%/Microsoft/Teams/GPUCache', '%LOCALAPPDATA%/Packages/MSTeams_*/LocalCache/Microsoft/MSTeams/EBWebView/*/Cache']
  },
  {
    id: 'discord-cache', app: 'Discord', category: '聊天与办公', item: '应用缓存',
    description: '图片、代码和显卡缓存，不清理账号和会话数据。', risk: 'safe', selected: true,
    patterns: ['%APPDATA%/discord/Cache', '%APPDATA%/discord/Code Cache', '%APPDATA%/discord/GPUCache', '%APPDATA%/discord/Crashpad/reports']
  },
  {
    id: 'slack-cache', app: 'Slack', category: '聊天与办公', item: '应用缓存',
    description: '网页、代码和显卡缓存，不清理工作区或登录信息。', risk: 'safe', selected: true,
    patterns: ['%APPDATA%/Slack/Cache', '%APPDATA%/Slack/Code Cache', '%APPDATA%/Slack/GPUCache', '%APPDATA%/Slack/logs']
  },
  {
    id: 'dingtalk-cache', app: '钉钉', category: '聊天与办公', item: '应用缓存',
    description: '仅通用网页缓存与日志，不清理聊天和下载文件。', risk: 'safe', selected: true,
    patterns: ['%APPDATA%/DingTalk/Cache', '%APPDATA%/DingTalk/Code Cache', '%APPDATA%/DingTalk/GPUCache', '%LOCALAPPDATA%/DingTalk/Cache']
  },
  {
    id: 'feishu-cache', app: '飞书 / Lark', category: '聊天与办公', item: '应用缓存',
    description: '仅网页、代码与图形缓存，不清理账号数据。', risk: 'safe', selected: true,
    patterns: ['%APPDATA%/Lark/Cache', '%APPDATA%/Lark/Code Cache', '%APPDATA%/Lark/GPUCache', '%APPDATA%/Feishu/Cache', '%APPDATA%/Feishu/Code Cache', '%APPDATA%/Feishu/GPUCache']
  },
  {
    id: 'zoom-cache', app: 'Zoom', category: '聊天与办公', item: '日志和崩溃报告',
    description: '仅诊断日志和崩溃报告，不清理会议录制。', risk: 'safe', selected: true,
    patterns: ['%APPDATA%/Zoom/logs', '%APPDATA%/Zoom/data/Crashpad/reports']
  },

  {
    id: 'vscode-cache', app: 'Visual Studio Code', category: '开发工具', item: '编辑器缓存',
    description: '界面、扩展下载和日志缓存；不会删除项目、设置或已安装扩展。', risk: 'safe', selected: true,
    patterns: ['%APPDATA%/Code/Cache', '%APPDATA%/Code/Code Cache', '%APPDATA%/Code/GPUCache', '%APPDATA%/Code/CachedData', '%APPDATA%/Code/logs']
  },
  {
    id: 'cursor-cache', app: 'Cursor', category: '开发工具', item: '编辑器缓存',
    description: '界面、代码和日志缓存；不会删除项目、设置或聊天历史。', risk: 'safe', selected: true,
    patterns: ['%APPDATA%/Cursor/Cache', '%APPDATA%/Cursor/Code Cache', '%APPDATA%/Cursor/GPUCache', '%APPDATA%/Cursor/CachedData', '%APPDATA%/Cursor/logs']
  },
  {
    id: 'npm-cache', app: 'npm', category: '开发工具', item: '软件包下载缓存',
    description: '已下载的软件包副本，需要时会重新下载。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/npm-cache', '%APPDATA%/npm-cache']
  },
  {
    id: 'pip-cache', app: 'Python / pip', category: '开发工具', item: '软件包下载缓存',
    description: 'pip 下载和构建缓存，不删除 Python 环境或已安装软件包。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/pip/Cache']
  },
  {
    id: 'nuget-cache', app: 'NuGet', category: '开发工具', item: 'HTTP 下载缓存',
    description: '仅 v3 HTTP 缓存，不删除全局软件包目录。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/NuGet/v3-cache']
  },
  {
    id: 'yarn-cache', app: 'Yarn', category: '开发工具', item: '软件包缓存',
    description: 'Yarn 下载缓存，需要时会重新下载。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/Yarn/Cache']
  },
  {
    id: 'gradle-cache', app: 'Gradle', category: '开发工具', item: '构建缓存',
    description: '可能体积较大；清理后项目下次构建会明显变慢。', risk: 'review', selected: false,
    patterns: ['%USERPROFILE%/.gradle/caches/build-cache-*', '%USERPROFILE%/.gradle/caches/transforms-*']
  },

  {
    id: 'steam-html-cache', app: 'Steam', category: '游戏', item: '网页界面缓存',
    description: 'Steam 商店与社区网页缓存，不删除游戏或存档。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/Steam/htmlcache', '%PROGRAMFILES(X86)%/Steam/config/htmlcache']
  },
  {
    id: 'steam-shader-cache', app: 'Steam', category: '游戏', item: '游戏着色器缓存',
    description: '可能很大；清理后游戏会重新编译着色器，首次运行可能卡顿。', risk: 'review', selected: false,
    patterns: ['%PROGRAMFILES(X86)%/Steam/steamapps/shadercache']
  },
  {
    id: 'epic-cache', app: 'Epic Games Launcher', category: '游戏', item: '启动器网页缓存',
    description: '仅启动器网页缓存，不删除游戏。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/EpicGamesLauncher/Saved/webcache*', '%LOCALAPPDATA%/EpicGamesLauncher/Saved/Logs']
  },
  {
    id: 'nvidia-cache', app: 'NVIDIA', category: '图形与创作', item: '显卡着色器缓存',
    description: 'DX/GL 着色器缓存，会在使用游戏或图形应用时重建。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/NVIDIA/DXCache', '%LOCALAPPDATA%/NVIDIA/GLCache', '%PROGRAMDATA%/NVIDIA Corporation/NV_Cache']
  },
  {
    id: 'amd-cache', app: 'AMD', category: '图形与创作', item: '显卡着色器缓存',
    description: 'AMD DX/OpenGL 缓存，会在使用游戏或图形应用时重建。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/AMD/DxCache', '%LOCALAPPDATA%/AMD/GLCache']
  },
  {
    id: 'adobe-media-cache', app: 'Adobe Creative Cloud', category: '图形与创作', item: '媒体缓存文件',
    description: 'Premiere/After Effects 可重建的媒体缓存；下次打开项目可能重新生成。', risk: 'review', selected: false,
    patterns: ['%APPDATA%/Adobe/Common/Media Cache', '%APPDATA%/Adobe/Common/Media Cache Files']
  },

  {
    id: 'recycle-bin', app: 'Windows 回收站', category: '深度清理', item: '已删除的文件',
    description: '通常能释放较多空间；清理后回收站中的文件将无法恢复。', risk: 'review', selected: false,
    patterns: ['%SYSTEMDRIVE%/$Recycle.Bin']
  },
  {
    id: 'windows-update-downloads', app: 'Windows 更新', category: '深度清理', item: '更新下载缓存',
    description: '已下载的更新安装包；需要管理员权限，系统需要时会重新下载。', risk: 'review', selected: false, admin: true,
    patterns: ['%WINDIR%/SoftwareDistribution/Download']
  },
  {
    id: 'delivery-optimization', app: 'Windows 更新', category: '深度清理', item: '传递优化缓存',
    description: 'Windows 用于局域网或互联网更新分发的缓存，可重新下载。', risk: 'review', selected: false, admin: true,
    patterns: ['%PROGRAMDATA%/Microsoft/Windows/DeliveryOptimization/Cache', '%WINDIR%/ServiceProfiles/NetworkService/AppData/Local/Microsoft/Windows/DeliveryOptimization/Cache']
  },
  {
    id: 'windows-memory-dumps', app: 'Windows', category: '深度清理', item: '系统内存转储',
    description: '蓝屏和系统崩溃诊断文件，可能非常大；近期需要排查蓝屏时请保留。', risk: 'review', selected: false, admin: true,
    patterns: ['%WINDIR%/MEMORY.DMP', '%WINDIR%/Minidump']
  },
  {
    id: 'system-error-reports', app: 'Windows', category: '深度清理', item: '全局错误报告',
    description: '系统级 Windows 错误报告归档，不影响日常使用。', risk: 'safe', selected: true, admin: true,
    patterns: ['%PROGRAMDATA%/Microsoft/Windows/WER/ReportArchive', '%PROGRAMDATA%/Microsoft/Windows/WER/ReportQueue', '%PROGRAMDATA%/Microsoft/Windows/WER/Temp']
  },
  {
    id: 'windows-upgrade-leftovers', app: 'Windows 升级', category: '深度清理', item: '升级下载残留',
    description: 'Windows 功能更新留下的安装文件；清理后可能需要重新下载升级包。', risk: 'review', selected: false, admin: true,
    patterns: ['%SYSTEMDRIVE%/$WINDOWS.~BT', '%SYSTEMDRIVE%/$WINDOWS.~WS', '%SYSTEMDRIVE%/$GetCurrent']
  },
  {
    id: 'windows-old', app: '旧版 Windows', category: '深度清理', item: '以前的 Windows 安装',
    description: '通常占用数 GB；删除后无法回退到升级前的 Windows，且需要管理员权限。', risk: 'review', selected: false, admin: true,
    patterns: ['%SYSTEMDRIVE%/Windows.old']
  },
  {
    id: 'windows-log-archives', app: 'Windows', category: '深度清理', item: '安装与维护日志归档',
    description: '旧 CBS CAB、Windows Update ETL 和系统安装日志，用于故障诊断。', risk: 'review', selected: false, admin: true,
    patterns: ['%WINDIR%/Logs/CBS/*.cab', '%WINDIR%/Logs/DISM/*.log', '%WINDIR%/Logs/WindowsUpdate/*.etl', '%WINDIR%/Panther/*.log']
  },
  {
    id: 'driver-installers', app: '显卡驱动', category: '深度清理', item: '驱动安装包解压目录',
    description: 'NVIDIA/AMD 安装程序在 C 盘根目录留下的解压文件，不会卸载当前驱动。', risk: 'review', selected: false, admin: true,
    patterns: ['%SYSTEMDRIVE%/NVIDIA', '%SYSTEMDRIVE%/AMD']
  },
  {
    id: 'uwp-temp-state', app: 'Microsoft Store 应用', category: '深度清理', item: '应用临时状态',
    description: '商店应用的 TempState 和临时目录；运行中的应用文件会跳过。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/Packages/*/TempState', '%LOCALAPPDATA%/Packages/*/AC/Temp']
  },
  {
    id: 'onedrive-logs', app: 'Microsoft OneDrive', category: '聊天与办公', item: '同步诊断日志',
    description: 'OneDrive 诊断和遥测日志，不删除云端或本地同步文件。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/Microsoft/OneDrive/logs']
  },

  {
    id: 'pnpm-store', app: 'pnpm', category: '开发工具', item: '全局软件包仓库',
    description: '可能占用数 GB；项目依赖仍在，但以后安装可能重新下载包。', risk: 'review', selected: false,
    patterns: ['%LOCALAPPDATA%/pnpm/store', '%USERPROFILE%/.pnpm-store']
  },
  {
    id: 'gradle-dependency-cache', app: 'Gradle', category: '开发工具', item: '依赖与发行版缓存',
    description: 'Gradle 依赖和下载的构建工具，清理后会在下次构建时重新下载。', risk: 'review', selected: false,
    patterns: ['%USERPROFILE%/.gradle/caches/modules-*', '%USERPROFILE%/.gradle/wrapper/dists']
  },
  {
    id: 'maven-repository', app: 'Maven', category: '开发工具', item: '本地依赖仓库',
    description: 'Maven 下载的依赖包，可能很大；清理后项目构建会重新下载。', risk: 'review', selected: false,
    patterns: ['%USERPROFILE%/.m2/repository']
  },
  {
    id: 'nuget-packages', app: 'NuGet', category: '开发工具', item: '全局软件包缓存',
    description: '.NET 项目使用的全局包副本，清理后还原项目时会重新下载。', risk: 'review', selected: false,
    patterns: ['%USERPROFILE%/.nuget/packages']
  },
  {
    id: 'go-build-cache', app: 'Go', category: '开发工具', item: '编译缓存',
    description: 'Go 编译缓存，不删除源码或已安装的工具。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/go-build']
  },
  {
    id: 'playwright-browsers', app: 'Playwright', category: '开发工具', item: '测试浏览器缓存',
    description: '自动化测试下载的 Chromium/Firefox/WebKit，清理后运行测试会重新下载。', risk: 'review', selected: false,
    patterns: ['%LOCALAPPDATA%/ms-playwright']
  },
  {
    id: 'cypress-cache', app: 'Cypress', category: '开发工具', item: '测试运行时缓存',
    description: 'Cypress 下载的测试运行时，清理后会重新下载。', risk: 'review', selected: false,
    patterns: ['%LOCALAPPDATA%/Cypress/Cache']
  },
  {
    id: 'jetbrains-cache', app: 'JetBrains IDE', category: '开发工具', item: '索引缓存与日志',
    description: 'IDE 索引和日志，清理后首次打开项目会重新索引。', risk: 'review', selected: false,
    patterns: ['%LOCALAPPDATA%/JetBrains/*/caches', '%LOCALAPPDATA%/JetBrains/*/log', '%LOCALAPPDATA%/JetBrains/*/tmp']
  },
  {
    id: 'docker-logs', app: 'Docker Desktop', category: '开发工具', item: '诊断日志',
    description: '只清理 Docker Desktop 日志，不删除镜像、容器或 WSL 虚拟磁盘。', risk: 'safe', selected: true,
    patterns: ['%LOCALAPPDATA%/Docker/log', '%APPDATA%/Docker/log']
  },

  {
    id: 'huggingface-models', app: 'Hugging Face', category: 'AI 与大缓存', item: '模型与数据集缓存',
    description: '可能占用数十 GB；删除后本地模型不可用，使用时需要重新下载。', risk: 'review', selected: false,
    patterns: ['%USERPROFILE%/.cache/huggingface/hub', '%USERPROFILE%/.cache/huggingface/datasets']
  },
  {
    id: 'torch-models', app: 'PyTorch', category: 'AI 与大缓存', item: '模型与扩展缓存',
    description: 'PyTorch Hub 模型、权重和编译扩展，删除后需要重新下载或编译。', risk: 'review', selected: false,
    patterns: ['%USERPROFILE%/.cache/torch', '%LOCALAPPDATA%/torch']
  },
  {
    id: 'ollama-models', app: 'Ollama', category: 'AI 与大缓存', item: '本地大模型',
    description: '这是模型本体而非普通垃圾，可能占用数十 GB；删除后必须重新下载。', risk: 'review', selected: false,
    patterns: ['%USERPROFILE%/.ollama/models']
  }
];

function expandEnvironment(input, env = process.env) {
  const upper = {};
  for (const [key, value] of Object.entries(env)) upper[key.toUpperCase()] = value;
  return P(input.replace(/%([^%]+)%/g, (token, name) => upper[name.toUpperCase()] || token));
}

module.exports = { staticRules, expandEnvironment };
