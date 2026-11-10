# 发布指南：GitHub + npm + DSH 插件市场

本文件是 `dsh-dokuwiki` 的维护者发布手册。发布 = 把代码推到 GitHub + 把包发到 npm，
DSH 生态的插件市场会按 npm 关键字自动收录。

## 0. 前置条件

- GitHub 账号（仓库可以先用网页创建）
- npm 账号（`npm login` 可用），且**必须开启两步验证（2FA）**：未开启时
  `npm publish` 会被 403 拒绝（`Two-factor authentication ... required to publish
  packages`）。发布时的验证方式取决于 2FA 类型：
  - 认证器 App（TOTP）：提示 `Enter OTP:` 时输入 6 位动态码，或用 `--otp <code>`；
  - 安全密钥 / Windows Hello（WebAuthn）：npm 会打印
    `Authenticate your account at: https://www.npmjs.com/auth/cli/...`，按 Enter
    打开浏览器完成授权即可（这种类型不能用 `--otp`）。
- 本机网络能访问：npm registry（`https://registry.npmjs.org`）、GitHub。
  **注意**：有的代理/防火墙环境会重置 `git clone/push https://github.com/...`，
  这时改用 SSH（`git@github.com`，22 或 `ssh.github.com:443`）—— 见第 2.2 节。

## 1. 发布前检查

```sh
npm test                    # 离线测试应全部通过
npm run smoke -- --url <任意可读 wiki> --user <账号>   # 可选，只读冒烟
npm pack --dry-run          # 检查将要发布的文件（不应含测试/凭据/本地路径）
npm publish --dry-run       # npm 侧预检
```

同时确认：

- `package.json`：`name`、`version`、`description`、`license`、`engines`、`keywords`
  （必须含 `dsh-plugin`、`deepseek-harness`）；
- `CHANGELOG.md` 已记录本次变更；
- 包根目录只保留一个 `README.*` 文件（npm 用它作为包页面的主 README）；其他语言版本
  （如中文 README）放到 `docs/` 下，否则在某些平台（尤其 Windows）上 npm 扫描
  `README*` 的顺序可能把中文 README 选成主 README；
- 提交身份用公开邮箱（如 GitHub 的 `users.noreply.github.com` 地址），不要把内部邮箱
  写进公开历史；首次发布可以压成一个干净的初始提交：

  ```sh
  git checkout --orphan clean-main
  git add -A
  git commit -m "feat: initial release"
  git branch -D main && git branch -m main
  git reflog expire --expire=now --all && git gc --prune=now
  ```

- 工作区干净：`git status` 无未提交内容。

## 2. 发布到 GitHub

### 2.1 创建仓库

网页方式：GitHub → New repository → 名称 `dsh-dokuwiki` → Public → 不要勾选
README/gitignore（本地已有）。

或安装 `gh` CLI 后：

```sh
gh repo create <你的用户名>/dsh-dokuwiki --public --source=. --remote=origin
```

### 2.2 配置认证（SSH 推荐）

如果 `git ls-remote https://github.com/...` 报 `Connection was reset`，说明这个网络环境
对 git 的 HTTPS 不友好；改用 SSH：

```sh
# 1) 生成密钥（已有可跳过）
ssh-keygen -t ed25519 -C "your@email"

# 2) 把公钥内容添加到 GitHub：
#    GitHub → Settings → SSH and GPG keys → New SSH key
#    Windows: type %USERPROFILE%\.ssh\id_ed25519.pub
#    Linux/macOS: cat ~/.ssh/id_ed25519.pub

# 3) 测试（首次会询问 host key，输入 yes）
ssh -T git@github.com
# 成功时输出: Hi <用户名>! You've successfully authenticated...

# 4) 如果 22 端口也不通，可改走 443：在 ~/.ssh/config 加
#    Host github.com
#      HostName ssh.github.com
#      Port 443
#      User git
```

### 2.3 关联远程并推送

```sh
git remote add origin git@github.com:<你的用户名>/dsh-dokuwiki.git
git branch -M main
git push -u origin main
```

### 2.4 补全仓库元数据

把 `package.json` 里的仓库信息补上（npm 页面和插件管理器的展示会用到），然后提交：

```json
"repository": { "type": "git", "url": "git+https://github.com/<你>/dsh-dokuwiki.git" },
"homepage": "https://github.com/<你>/dsh-dokuwiki#readme",
"bugs": { "url": "https://github.com/<你>/dsh-dokuwiki/issues" }
```

```sh
git add package.json && git commit -m "chore: add repository metadata" && git push
```

## 3. 发布到 npm

```sh
npm login          # 按提示在浏览器完成登录
npm publish        # 公开包；package.json 里已声明 MIT
# 第一次发布还要在浏览器里完成 2FA 授权，方式见第 0 节
```

验证：

```sh
npm view dsh-dokuwiki version dist-tags repository
npm view dsh-dokuwiki dependencies     # 应为空（零运行时依赖）
```

> 首次发布新包时 registry 需要几分钟后台处理；这期间 `npm view` 可能只看到一个
> `0.0.0-stage` 临时占位版本（描述是 "Temporary package placeholder for staged
> publishing"）。等处理完成后真正的版本才会出现在 `dist-tags.latest` 上，属正常现象。

### 自动化发布（Trusted Publishing，推荐）

手动 `npm publish` 每次都要浏览器 2FA。配置一次 **Trusted Publishing（OIDC）** 之后，
推送 `v*` tag 就由 GitHub Actions 自动发布，不需要任何 token 或 2FA：

1. 打开 npm 包页面 → **Settings → Trusted publishing** → Add GitHub Actions：
   - Organization or user：你的 GitHub 用户名
   - Repository：`dsh-dokuwiki`
   - Workflow filename：`publish.yml`
2. 仓库里已有 `.github/workflows/publish.yml`（`id-token: write` + `npm publish
   --provenance`），它会校验 tag 与 `package.json` 版本号一致。
3. 发版：

   ```sh
   npm version patch          # 或 minor / major，会创建 vX.Y.Z tag
   git push --follow-tags     # 推 tag 即触发自动发布（带 provenance）
   ```

仍有 2FA 的账号也可以继续手动 `npm publish` 作为回退；两条路发布的是同一个包。

后续发新版本：

```sh
# 改代码 → 更新 CHANGELOG → 提升版本号
npm version patch      # 或 minor / major；会创建 git tag
git push --follow-tags # 配置了 Trusted Publishing 即自动发布
```

## 4. 插件市场收录

收录不是自动的：主流市场都要求**投稿 PR**（描述见仓库的收录规范），npm 关键字只起辅助作用。

- **awesome-dsh-plugin**（dsh-market 可视化市场的数据源）：在 `data/plugins/`
  加一个 `<owner>__<repo>.yml`，PR 通过静态校验后由维护者合并；
- **1024 Store**（deepseek1024.com）：在 `catalog/plugins/` 加一个
  `<owner>--<repo>.json`，静态校验通过后自动合并并同步到网站；
- npm 关键字 `dsh-plugin`、`deepseek-harness` 供部分工具/目录扫描，发布后自动出现
  的机制并不可靠，以投稿为准。
- README 第一段写清楚用途和安装命令，市场页面会展示。

## 5. 安装验证

```sh
# 干净 profile 验证
dsh plugin --profile test --from-default-profile web   # 首次会初始化
dsh plugin --profile test add dsh-dokuwiki
dsh --profile test --dump-config | grep dsh-dokuwiki
```

在桌面版 DSH 里：侧边栏 → 插件 → 搜索/粘贴包名安装 → 插件卡片打开配置页，
填 base URL/账号/密码 → 测试连接 → 保存。

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| `git push` 报 `Recv failure: Connection was reset` | git HTTPS 被屏蔽：改用 SSH（第 2.2 节）或配置代理 `git config --global http.proxy http://127.0.0.1:<port>` |
| `ssh -T git@github.com` 报 `Permission denied (publickey)` | 公钥没加到 GitHub，或加错账号；重新复制 `id_ed25519.pub` 内容到 Settings → SSH keys |
| 22 端口不通 | 用 `ssh.github.com:443`（第 2.2 节第 4 步） |
| `npm publish` 报 403/401 | 未登录或账号无权限；`npm login` 后重试；公司镜像源可能需要切回 npmjs |
| `npm publish` 报版本已存在 | 提升 `version` 再发布，不能覆盖已发布版本 |
| `npm publish --dry-run` 里出现测试/凭据文件 | 检查 `package.json` 的 `files` 白名单与 `.gitignore` |
| 插件安装后配置页不出现 | 检查安装后的包名与 `cordis.patch.yml` 的 `name` 是否完全一致 |

## 7. 发布后

- 在 GitHub 打 tag / 填 Release notes（可复制 CHANGELOG）；
- 给 README 加一张配置页截图，市场页面更易被安装；
- 收到 issue 时先跑 `npm test` 与 `npm run smoke -- --url ...` 复现；
- 安全相关 issue 不要公开细节，先修再发版。
