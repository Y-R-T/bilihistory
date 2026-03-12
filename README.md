# Bilibili Feed History (B站首页推荐流回溯)

📺 **Bilibili Feed History** 是一款开源的 Chrome/Edge 浏览器扩展。它能在你访问 B 站首页时，自动无感地记录下每一次“换一换”的新旧推荐流数据。你可以随时通过“回溯”按钮找回刚刚不小心刷走的视频，或者在历史记录弹窗中查阅过去的推荐卡片。

![Extension Preview](https://via.placeholder.com/800x400?text=Bilibili+Feed+History+Preview) <!-- 建议在此处上传截图替换链接 -->

## ✨ 核心特性

- **无感记录**：后台静默捕获首页 `bilibili.com` 的推荐视频卡片。
- **无限回溯**：原生接入 B 站 UI，在刷新按钮旁提供 `⏪ 回溯` 与 `⏩ 前进` 按钮。
- **DOM 防污染渲染**：独具创新的挂载注入技术，无论怎么回溯都不会破坏 B 站本身的 Vue 组件状态与刷新逻辑，实现完美兼容。
- **存储优化**：采用 `chrome.storage.local`，加入指纹去重（消除恶意重绘产生的冗余快照）和 LRU 淘汰机制（最高保留 500 次刷新记录），既保证速度又节省内存。
- **历史管理面板**：点击扩展图标即可打开暗色主题的数据面板，按现实时间线梳理你的推荐流历史。

## 📦 安装说明 (安装稳定版)

我们提供了已经打包好的 ZIP 发布版本，您可以直接下载使用：

1. 前往 GitHub 的 **[Releases](https://github.com/YourUsername/bilihistory/releases)** 页面。
2. 下载最新版本（如 `BilibiliFeedHistory-v1.0.0.zip`）。
3. 将下载的 ZIP 文件**解压**到一个固定的文件夹中。
4. 打开浏览器的扩展程序页面：
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
5. 开启右上角的 **“开发者模式”**。
6. 点击左上角的 **“加载已解压的扩展程序”**，选择你刚刚解压的那个文件夹。
7. 完成！你可以去 B 站首页试试看。

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

## 💡 存储技术内幕

扩展并没有使用容易跨域或者 API 陈旧的传统方法，而是通过 `chrome.runtime.sendMessage` 通信，依赖 `chrome.storage.local` 构建持久层。
- 指纹生成：`c => ${c.title}|${c.url}`
- 防止重复捕获的 500ms 动态防抖。
- `outerHTML` 无损保存：哪怕 B 站修改了 DOM 层级，只要旧的字符串不变，回溯视图永远是 100% 保真的。

## 📄 许可协议
[MIT License](LICENSE)
