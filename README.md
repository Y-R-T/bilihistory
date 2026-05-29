# Bilibili Feed History (B站首页推荐流回溯)

📺 **Bilibili Feed History** 是一款开源的 Chrome/Edge 浏览器扩展。它能在你访问 B 站首页时，自动无感地记录下每一次“换一换”的新旧推荐流数据。你可以随时通过“回溯”按钮找回刚刚不小心刷走的视频，或者在历史记录弹窗中查阅过去的推荐卡片。

## ✨ 核心特性

- **无感记录**：后台静默捕获首页 `bilibili.com` 的推荐视频卡片。
- **无限回溯**：原生接入 B 站 UI，在刷新按钮旁提供 `⏪ 回溯` 与 `⏩ 前进` 按钮。
- **结构化历史回放**：保存标题、链接、封面、作者、播放信息、时长等结构化字段，用统一卡片模板恢复历史内容。
- **存储优化**：采用 `chrome.storage.local`，加入指纹去重、最多 500 条快照与约 8 MiB 本地容量预算，超出后优先淘汰更早的记录。
- **历史管理面板**：点击扩展图标即可打开暗色主题的数据面板，按现实时间线梳理你的推荐流历史。

## 📦 安装说明 (安装稳定版)

当前版本请优先使用 ZIP 安装。GitHub Releases 中同时提供 ZIP 与 CRX，但 Chrome / Edge 对来自 GitHub 的本地 CRX 有未知来源限制，可能出现安装后无法启用的情况。

推荐安装方式：

1. 前往 GitHub 的 **[Releases](https://github.com/Y-R-T/bilihistory/releases)** 页面。
2. 下载最新版本中的 `BilibiliFeedHistory-vX.X.X.zip`。
3. 将 ZIP 文件**解压**到一个固定的文件夹中，不要安装后删除这个文件夹。
4. 打开浏览器的扩展程序页面：
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
5. 开启右上角的 **“开发者模式”**。
6. 点击 **“加载已解压的扩展程序”**，选择刚刚解压出来的文件夹。
7. 完成后，打开 B 站首页即可使用。

关于 CRX：

- `BilibiliFeedHistory-vX.X.X.crx` 主要用于企业策略分发、自托管更新或开发测试。
- 普通用户从 GitHub 下载 CRX 后，Chrome / Edge 可能会提示来源未知，并禁止启用。
- 后续上架 Chrome Web Store / Microsoft Edge Add-ons 后，会提供更适合普通用户的一键安装方式。

## 🛠️ 源代码结构与本地开发

如果你想参与项目开发、修改样式或者学习其原生的隔离渲染架构：

```text
├── manifest.json      # 扩展声明与核心权限配置 (Manifest V3)
├── background.js      # Service Worker (全生命周期的存储与队列管理)
├── content.js         # Content Script (负责 B 站 DOM 的监听、解析与注入)
├── content.css        # 为注入的 DOM 提供的样式补偿
├── popup.html         # 扩展点击弹窗的面板骨架
├── popup.js           # 历史时间线与详细卡片逻辑
├── popup.css          # 面板的暗色美学与动画支持
└── icons/             # 扩展多尺寸图标
```

### 开发构建
本项目无需 Node.js / Webpack 构建，完全基于原生 JavaScript 编写，即改即生效。修改完代码后，直接在浏览器扩展页面点击“更新/加载”即可测试。

## 🔒 隐私与本地存储

- 所有历史数据都保存在浏览器本地的 `chrome.storage.local` 中。
- 扩展不会把历史记录上传到开发者服务器，也不依赖任何远程数据库。
- 当前记录的字段包括：标题、链接、封面、作者、播放信息、弹幕信息、时长。
- 历史快照最多保留 500 条，超出后会优先淘汰更早的记录。
- 你可以点击扩展弹窗右上角的清空按钮，随时删除本地历史。

## 💡 存储技术内幕

扩展通过 `chrome.runtime.sendMessage` 通信，依赖 `chrome.storage.local` 构建持久层。
- 指纹生成：`c => ${c.title}|${c.url}`
- 推荐流 DOM 变化通过 `MutationObserver` 观察；普通变化使用 120ms 防抖，“换一换”后保留约 2000ms 观察窗口以捕获后续批次变化。
- 历史回放基于结构化字段渲染，而不是持久化保存页面原始 HTML。

## 📄 许可协议
[GNU Affero General Public License v3.0](LICENSE)

## 🙏 致谢

- [linux.do](https://linux.do/)
