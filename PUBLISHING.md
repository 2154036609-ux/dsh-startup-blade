# 发布到插件市场（dsh.so）

现在的主渠道是 **[dsh.so 提交页](https://www.dsh.so/zh/submit/)**：粘贴仓库地址或 npm 包名，
站点服务端会拉源码、校验格式、跑安全扫描，然后一键生成符合 schema 的市场条目（以 Issue 形式进审核）。
比手动给 awesome-dsh-plugin 提 PR 简单得多，**推荐走这条**。

---

## 路线 A：不装任何工具（最省事）

适合只想把插件挂上去、不想折腾命令行的人。

1. **建仓库**：打开 <https://github.com/new>，仓库名填 `dsh-startup-blade`，选 **Public**，不要勾 README（避免冲突），Create。
2. **上传文件**：把本目录（桌面上的 `dsh-startup-blade`）里的内容**全选拖进**网页的上传区，提交。
   - 要传：`package.json`、`cordis.patch.yml`、`lib/`、`assets/`、`docs/`、`icon.png`、`README*`、`LICENSE`、`screenshots.json`、`.gitignore`
   - 可以不传：`dsh-startup-blade-1.0.0.tgz`、`market/`、`scripts/`、`PUBLISHING.md`
3. **加话题**：仓库页右上 **⚙ Topics** → 填 `dsh-plugin` → 保存。（市场会自动索引）
4. **改占位符**：GitHub 网页里把 `package.json` 的 `repository` / `homepage` / `bugs` 和 `LICENSE` 里的
   `2154036609-ux` 改成你的用户名（网页编辑器就能改，Edit → 提交）。
5. **提交收录**：打开 <https://www.dsh.so/zh/submit/> → 在输入框粘贴 `你的用户名/dsh-startup-blade`
   → 点「开始检查」→ 等它跑完（拉取 + 校验 + 安全扫描）→ 通过后点「提交到 dsh.so」。
6. 审核合并后，市场里就能搜到；安装命令形如
   `dsh plugin --profile web add github:你的用户名/dsh-startup-blade`。

> 走这条路线**不需要 npm**。市场里大量条目 `npm` 字段是 `null`，照样收录。

---

## 路线 B：命令行（发 npm + 一条命令搞定）

装好 Git、GitHub CLI 并登录后：

```powershell
winget install Git.Git GitHub.cli
gh auth login
npm login                     # 不发 npm 可跳过

cd "$env:USERPROFILE\Desktop\dsh-startup-blade"
./scripts/publish.ps1 -Owner 你的GitHub用户名          # 建仓 + 推送 + 加 topic + 发 npm
./scripts/publish.ps1 -Owner 你的GitHub用户名 -SkipNpm # 不发 npm
```

脚本跑完会把「提交到 dsh.so」需要的信息打印出来；到 <https://www.dsh.so/zh/submit/> 粘贴仓库地址即可。

---

## dsh.so 的收录门槛（自查表）

| 要求 | 本插件 |
|---|---|
| `package.json` 里有 `dsh` 字段 | ✅ `dsh.bundle.patch` + `dsh.client` |
| README 带安装说明 | ✅ 中英双份 |
| SPDX 可识别的开源许可 | ✅ MIT |
| 插件 id 符合 `^[a-z0-9]+(-[a-z0-9]+)*$` | ✅ `dsh-startup-blade` |
| 仓库含可扫描源码（JS/TS） | ✅ `lib/*.js` |
| 安全扫描无阻断项（硬编码密钥 / 数据外传 / 破坏性操作 / 挖矿） | ✅ 无密钥、无外部请求、只读文件 |

> 扫描对象是**已发布的 tarball**（npm 条目）或**仓库源码**（Git 条目）。我们的网络调用只有
> 同源相对路径（`/startup-blade/*`），不向任何第三方发数据。

---

## 另一条老路径（可选）

手动给 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提收录 PR，
条目文件已按格式写好：`market/2154036609-ux__dsh-startup-blade.yml`（需把 `2154036609-ux` 换成你的用户名，
文件名同步改成 `<owner>__dsh-startup-blade.yml`）。这条路要求仓库创建满 1 天才过 CI，
而 dsh.so 那条没有这个限制 —— 优先走 dsh.so。
