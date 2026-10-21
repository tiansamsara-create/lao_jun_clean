# v0.3.0：单盘分析与安全系统清理

查阅日期：2026-09-29。独立实现，没有复制或运行第三方清理脚本。

- [WinDirStat](https://github.com/windirstat/windirstat)：参考单盘扫描、目录总量、大文件排序、逻辑/物理大小区别、硬链接去重及目录链接排除。当前使用普通文件系统扫描，未实现 MFT 直读或物理分配字节测量。
- [BCUninstaller](https://github.com/BCUninstaller/Bulk-Crap-Uninstaller)：参考传统软件与 Microsoft Store 应用分别识别、通过对应的卸载方式管理。商店应用跳转 Windows 管理界面。
- [微软：清理 WinSxS](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/clean-up-the-winsxs-folder?view=windows-11)：组件仓库只能通过支持的 Windows 维护方式清理。本版提供只读 DISM 分析与交互式 cleanmgr / 存储设置入口，不自动执行组件清理或 ResetBase。
- [微软：WinSxS 实际大小](https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/determine-the-actual-size-of-the-winsxs-folder?view=windows-11)：共享硬链接会令普通目录求和失真，因此报告明确标记逻辑大小，不能等同于可释放空间。

## 功能边界

每次只接收一个由本机枚举得到的可用磁盘。全盘目录统计包含小文件，最多保存最大的 2000 个超过阈值的文件。可停止扫描，并保留标记为部分结果的数据。无权限位置、链接和硬链接去重均记录数量。

文件说明基于路径、扩展名和登记的软件安装位置，不读取文件内容，也不会把未知数据判断成垃圾。文档/数据库、系统、安装目录、AppData、虚拟磁盘仅查看。用户确认的媒体、安装包等可以移入回收站；不提供永久删除回退。清理前按本次扫描 ID、文件元信息和每一级目录链接状态再次核对。

回收站保留数据仍占用原盘空间，界面不会称其已释放。Windows 更新缓存、传递优化、旧系统、升级残留和回收站从旧的直接删除规则中移除，转由 Windows 原生清理入口管理。
