# 老君清

作者：兲samsara；chatgpt

一个面向 Windows 10/11 的本地磁盘分析与清理工具，包含缓存清理、软件管理、单盘大文件和系统空间分析。

## 主要功能

- 按软件展示扫描结果，支持分类、搜索、展开查看具体清理项。
- 显示每一项的大小、文件数、风险等级、说明与实际路径。
- 内置 Windows、Chrome、Edge、Firefox、微信、QQ、Teams、Discord、Slack、钉钉、飞书、Zoom、VS Code、Cursor、npm、pip、NuGet、Yarn、Gradle、Steam、Epic、NVIDIA、AMD、Adobe 等规则。
- 自动发现其他 Electron/Chromium 软件的通用缓存，默认不勾选。
- 垃圾清理规则不包含个人文档、下载内容、聊天记录、浏览器密码、Cookie、书签和历史记录；单盘分析只读取文件元数据。
- 清理前二次确认；路径白名单校验；不跟随符号链接；占用或无权限文件会跳过。
- 清理行为记录到本机 JSONL 审计日志，不含遥测，不上传扫描结果。
- 软件管理页支持选择磁盘，读取传统软件和当前用户的 Microsoft Store 应用，提供用途解释与大小排序；商店应用由 Windows 设置管理。
- 单盘大文件：100 MB / 500 MB / 1 GB 阈值、最多最大的 2000 个文件、目录排行榜、路径/类型/软件搜索、停止扫描。硬链接去重，不跟随目录链接。
- 大文件清理通过系统回收站执行，必须用户确认；系统/程序/数据库等受保护类型只查看。回收站仍占空间，不能视为已释放。
- 系统空间页提供只读 DISM 组件仓库分析、交互式 Windows 磁盘清理、存储设置。更新缓存、旧系统、传递优化与回收站不再由本软件直接删除。
- 大缓存识别覆盖 pnpm、Gradle、Maven、NuGet、Playwright、JetBrains、Hugging Face、PyTorch 和 Ollama；高影响项默认不勾选。

## 运行

需要 Node.js 20 或更高版本。

```powershell
npm install
npm start
```

运行测试：

```powershell
npm test
```

生成 64 位 Windows 便携版：

```powershell
npm run dist
```

成品会输出到 `release/LaoJunQing-0.3.0-portable.exe`。

v0.2.2：16 路有限并发清理、实时文件计数、停止清理按钮；清理后直接扣除本次删除量，不再自动全量重扫。

## 安全边界

垃圾清理只处理规则中明确列出的缓存目录，属于永久删除，界面要求再次确认。单盘大文件清理采用回收站，不回退为永久删除。用途说明基于本地规则和安装目录匹配，不读取文件内容；未知文件不默认判为垃圾。

软件卸载启动该软件在 Windows 注册的原生卸载程序，由用户在原生界面中确认。商店应用打开 Windows 已安装应用。系统更新、旧系统通过原生磁盘清理维护；不直接删除组件仓库或 Installer。

建议关闭准备清理的软件后再操作。普通用户权限可以清理自己的软件缓存；`Windows Temp` 等系统级位置需要管理员权限，无权限时会安全跳过。

删除引擎从磁盘/共享根目录逐级检查缓存根路径的祖先链，拒绝符号链接和 junction。枚举后及执行 `unlink` / `rmdir` 前，重新核对相关路径的链接状态与身份（设备号、文件标识、创建时间和模式）；发现变化或无法复核时，记录跳过/错误并停止本次根路径下的后续删除，已启动的任务在后续校验点退出。保留缓存根目录，仅对成功删除的文件累计数量与复核时的字节数。

这些检查不是原子安全保证：Node.js 的路径式文件系统 API 无法将整条祖先链的检查与删除绑定为一次操作，最后一次检查后仍可能发生路径替换或文件内容变化。不要在其他进程正在重定向这些目录时清理；字节统计也不代表此类并发修改下精确的磁盘空间释放量。

路径安全回归测试仅使用临时夹具，覆盖根路径/祖先 junction、删除前替换路径、普通深层目录清理和外部哨兵保护；保留并发、取消与原有测试。可单独运行 `node --test tests/delete-engine.test.js`，再运行 `npm test`；2026-10-21 外部验证：完整测试25项通过；未执行真实用户目录清理或打包。

## 设计参考

v0.3.0 的研究与限制详见 [RESEARCH.md](RESEARCH.md)。本机诊断记录不随源码发布。

- [BleachBit](https://github.com/bleachbit/bleachbit)：声明式、按应用组织的清理规则。
- [WindowsCleaner](https://github.com/denfry/WindowsCleaner)：先扫描预估、分级展示风险。
- [Sifty](https://github.com/Vortrix5/sifty)：预览、受保护路径和审计思路。
- [SystemManager](https://github.com/laurentiu021/SystemManager)：将缓存与账号/会话数据分开，并对高影响项默认不勾选。
- [FluentCleaner](https://github.com/builtbybel/FluentCleaner)：规则明确、可检查，不使用模糊的全盘通配删除。
- [Jharu](https://github.com/riponcm/Jharu)：区分可重建开发缓存、AI 模型和普通用户数据。
- [Microsoft cleanmgr 文档](https://learn.microsoft.com/windows-server/administration/windows-commands/cleanmgr)：Windows 原生磁盘清理项目与边界。

## 目录结构

```text
src/
  core.js              扫描、计量、路径保护与清理引擎
  rules.js             清理规则库
  main.js              Electron 主进程与 IPC
  preload.js           最小权限渲染层桥接
  renderer/            桌面界面
tests/                  核心安全与扫描测试
```

## 许可证

MIT
