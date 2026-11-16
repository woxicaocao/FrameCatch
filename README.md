# 映取 FrameCatch

中文 Windows 便携视频下载器，适用于 Windows 10 22H2 / Windows 11 x64。粘贴链接、自动分析、选择画质、下载完整视频。使用 Electron、React、yt-dlp 和 FFmpeg，全部在本机运行，无需 AI API。

## 使用便携版

1. 将 `FrameCatch-1.5.0-Windows-x64-portable.zip` **完整解压**到有写入权限的目录。
2. 双击 `FrameCatch.exe`。请保留旁边的所有文件及 `resources` 文件夹。
3. 在下载工作台粘贴网页链接，等待分析，选择画质后点击下载。
4. 完成后点击任务旁的文件夹按钮定位成品。

首次启动会在软件旁建立 `data` 和 `Downloads`。设置可修改保存目录、选择 Netscape 格式的 `cookies.txt`、填写 HTTP/SOCKS5 代理。软件无需管理员权限，不注册系统服务或文件关联。

## 支持与行为

- 1.5 新增“抖音 / 视频号”标签页，支持完整分享文案、短链及单条作品网址识别；抖音 `modal_id` 精确转换作品地址。抖音的普通入口受限制时尝试软件自身的网页分析，仍无法取得媒体时保留正常浏览器辅助入口。视频号二维码预览页没有返回视频资源时会明确提示，不能保证该类分享可直接下载。具体样例实测见 `docs/抖音与视频号.md`。

- 1.4 新增记住本机配对：首次输入配对码后，重启映取、Chrome 或重新加载插件可自动重连。可暂停自动连接或忘记配对；软件需保持运行。只持久保存随机本机配对凭据，视频 Cookie 与候选仍只保存在扩展会话中。

- B 站、YouTube、Vimeo、新片场使用 yt-dlp 对应站点解析器。
- Behance 和其他网页尝试提取公开媒体、嵌入视频；不保证任意页面均可下载。
- 同一视频的 HLS/DASH 传输分片自动合并；分离的音轨和视频轨自动组合。
- 最高画质优先，尽量直接封装而不转码；兼容时使用 MP4，其他情况使用 MKV。
- 多 P、播放列表先选择条目，再分别保存；不自动拼成一部长片。
- 单任务顺序队列，支持取消、失败重试、中断后尝试续传和历史记录。
- 普通解析失败时，可点“浏览器辅助分析”，在隔离窗口手动播放后选择检测到的 HLS/DASH 清单或 MP4。
- 1.3 新增 Chrome 浏览器助手：在正常登录的浏览器启用当前页检测，选择完整视频一键发送到映取，再选择画质下载。插件仅接收所选媒体的实际请求信息，经本机配对连接，不扫描 Chrome 密码或账号数据库。加载与配对见 `docs/浏览器插件辅助.md`。
- 1.3.1 修复 Vimeo/Behance 捕获到受签名约束的局部 MP4 却标作完整视频的问题，并新增 Vimeo `playlist.json` 总清单解析：保留初始化数据、完整视频与独立音轨分片，交由原下载引擎合并。旧片段及过期签名无法补成原作品，需更新插件后刷新并重新捕获。
- 内置浏览器也被网站验证拦截时，可在正常 Chrome 复制一条媒体请求为 cURL，使用“导入 Chrome 视频请求”。无需浏览器扩展，不运行粘贴的命令，详见 `docs/Chrome接力下载.md`。
- 1.2.1 修复新片场 CDN 的 MP4 直链缺少必要请求头而返回 403 的问题；修复后已用用户实际作品完成下载与全片解码。网页本身的访问验证仍可能限制普通解析。
- 登录、账号权限、网络可达性、网站验证可能影响下载。软件面向点播，不提供 DRM 解密，也不会自动完成网站验证。

分析成功不代表站点一定允许下载；下载过程中若链接过期、限流或缺片，会显示失败原因，不将不完整视频标为成功。

## 文件与隐私

配置、浏览器缓存、任务历史和日志保存在便携目录 `data` 内。日志隐藏 Cookie 和代理凭据。Cookie 文件只由本机下载引擎使用，不上传至应用服务器；请妥善保管便携文件夹和 Cookie 文件。

辅助浏览器使用 `data/helper-browser` 独立会话，不读取已安装 Chrome 的账号或 Cookie。选择媒体时，仅导出相关站点的会话 Cookie 至 `data/captures`，并保留播放请求的来源页面、浏览器标识和代理，供本机下载使用。不要分享这些目录或含登录态的整套便携文件夹。登录和验证由你在辅助窗口手动完成。

1.2 的 Chrome 请求导入仅在你显式点击或粘贴时接收文本，不后台读取剪贴板。原始请求不写入日志，Cookie 值不显示在界面。导入只支持媒体 GET/HEAD，并拒绝命令链、外部文件引用及账号 API 凭据。

任务分片和中间文件默认保留，输出目录的 `.framecatch-staging` 中也可能保存任务的临时副本或硬链接。完成任务的“清理临时文件”会先展示目录、数量和逻辑大小，获得明确确认后才删除；完整视频和任务记录保留。软件不自动删除用户文件。

移动软件文件夹时，位于原便携目录内部的任务路径会迁移到新位置；自行选择的外部输出目录保持原路径。请先关闭软件再移动文件夹。

## 开发

需要 Node.js 24 或更新的受支持版本，以及 Windows x64。

```powershell
npm ci
npm run deps:prepare
npm run dev
```

```powershell
npm run typecheck
npm test
npm run build
npm run test:smoke
npm run test:browser
npm run test:request
npm run test:extension-unit
npm run test:social-ui
npm run test:social-real
npm run test:extension-reconnect
npm run test:extension
npm run test:vimeo-extension
npm run package:portable
npm run test:portable
```

打包输出位于 `releases/build-时间戳/`，`releases/latest-build.json` 记录最新产物。构建使用新目录，保留之前的产物。依赖下载缓存和测试产物也会保留。

## 依赖与许可

独立下载组件位于 `resources/bin`，版本、来源与校验记录见 `resources/dependencies.json`，许可证见 `resources/licenses`。Electron、Chromium、Node 和前端依赖的许可随发行包提供。应用本身采用 MIT 许可。

站点经常变更。手动更新说明、详细使用帮助及本次实际兼容结果见 `docs`。
