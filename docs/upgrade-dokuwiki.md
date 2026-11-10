# DokuWiki 升级操作指南（runbook）

> 面向自建 DokuWiki 的服务器管理员。升级会改动**服务器文件系统并重启 Web 服务**，
> 属于运维操作：请先备份、在维护窗口执行、逐项确认。`dsh-dokuwiki` 插件本身**不提供**
> 升级功能 — 它是一个客户端访问插件，不应修改 wiki 服务器。
>
> 本指南也是给 agent 的执行手册：agent 只有在用户明确授权、且能访问服务器 shell 时，
> 才可按本文件逐步操作；每一步都要先确认再执行。

## 0. 什么时候升级

- 官方有安全更新或当前版本已 EOL/过旧（https://www.dokuwiki.org/changes）；
- 插件/模板要求更新版本；
- 需要新版本功能。

升级前先确认目标版本对 PHP 的要求。例如：

| DokuWiki 版本 | PHP 最低要求 |
|---|---|
| `2024-02-06 "Kaos"` | 7.4+ |
| `2026-07-14 "Mort"` | **8.2.0+**（见发布包 `install.php` 里的 `version_compare`） |

不确定时：下载发布包后看 `install.php` 中的 `version_compare(phpversion(), '8.2.0', '<')`，
或查对应版本的官方 release notes。

## 1. 升级前准备

1. 记录当前版本：查看 `dokuwiki/VERSION` 文件，或登录 wiki → 管理 → 版本信息；
   也可以用 `dsh-dokuwiki` 的 `wiki_status`（会显示 XML-RPC 版本）。
2. 列出**自定义插件和模板**（升级时要保留）：
   - `dokuwiki/lib/plugins/<plugin>` 里不是官方随包自带的就是自定义插件；
   - `dokuwiki/lib/tpl/<template>` 同理。
3. 确认 PHP 版本满足目标版本：`php -v`（Windows 便携版通常看 `server/php` 目录里的版本）。
4. 准备维护窗口和回滚方案（见第 5 节）。
5. 通知使用者：升级期间 wiki 不可用。

## 2. 备份（必须）

```bash
# 停服务前先做一次完整备份
cp -a /path/to/dokuwiki /path/to/dokuwiki.backup-$(date +%Y%m%d)

# 或者至少备份这些用户数据：
#   conf/   （local.php、users.auth.php、acl.auth.php、plugins.local.php 等）
#   data/   （pages、attic、media、meta …）
```

Windows（PowerShell）示例（`C:\wiki\dokuwiki` 换成你的实际路径）：

```powershell
$wiki = 'C:\wiki\dokuwiki'
Copy-Item $wiki "$wiki.backup-$(Get-Date -Format yyyyMMdd)" -Recurse
```

## 3. 下载新版本

- 官方下载：https://download.dokuwiki.org/src/dokuwiki/dokuwiki-stable.tgz
  （或 https://download.dokuwiki.org/ 选择版本）
- GitHub Releases：https://github.com/dokuwiki/dokuwiki/releases

解压到临时目录，先确认 `VERSION` 和 PHP 要求：

```bash
tar -xzf dokuwiki-stable.tgz
cat dokuwiki-*/VERSION
```

## 4. 替换文件（保留用户数据）

> ⚠️ 原则：**新版本程序文件整体替换，用户数据与自定义扩展原样保留。**
> 常见错误是只覆盖部分文件（旧 `inc/` 与新 `lib/` 混用），或把 `conf/dokuwiki.php`
> 这种"随包默认配置"也保留下来（它应该用新版本的）。

### 4.1 停服务

```bash
sudo systemctl stop apache2     # 或 nginx/php-fpm；Windows 便携版则结束 mapache.exe
```

### 4.2 就位新版本

```bash
# 旧目录已备份；把新版本解压结果放到原位置
mv /path/to/dokuwiki-2026-07-14c /path/to/dokuwiki
```

### 4.3 拷回用户数据

```bash
# conf/ 里的用户配置（不要用旧 conf/dokuwiki.php）
cp -a /path/to/dokuwiki.backup/conf/local.php          /path/to/dokuwiki/conf/
cp -a /path/to/dokuwiki.backup/conf/users.auth.php     /path/to/dokuwiki/conf/
cp -a /path/to/dokuwiki.backup/conf/acl.auth.php       /path/to/dokuwiki/conf/
cp -a /path/to/dokuwiki.backup/conf/plugins.local.php  /path/to/dokuwiki/conf/   # 若有
# 其他 *.local.php / 自定义 mime.local.conf 等按需拷回

# data/：pages、attic、media、media_attic、media_meta、meta、meta_attic、deleted.files
cp -a /path/to/dokuwiki.backup/data/pages  /path/to/dokuwiki/data/
# …其余目录同理
```

**Windows/PowerShell 特别注意**：`Copy-Item -Recurse` 把目录拷到已存在的同名目录时会
**嵌套**（生成 `data/pages/pages`）。可靠做法是删除目标目录后再拷，或用 robocopy：

```powershell
$wiki = 'C:\wiki\dokuwiki'
$backup = 'C:\wiki\dokuwiki.backup-20240206'
Remove-Item "$wiki\data\pages" -Recurse -Force
robocopy "$backup\data\pages" "$wiki\data\pages" /E
```

### 4.4 拷回自定义插件与模板

```bash
cp -a /path/to/dokuwiki.backup/lib/plugins/my-plugin   /path/to/dokuwiki/lib/plugins/
cp -a /path/to/dokuwiki.backup/lib/tpl/my-template     /path/to/dokuwiki/lib/tpl/
```

### 4.5 清理缓存/索引（让新版本重建）

```bash
rm -rf /path/to/dokuwiki/data/cache/* /path/to/dokuwiki/data/index/* /path/to/dokuwiki/data/locks/*
# data/tmp 也可清空
```

## 5. 启动与验证

1. 启动 Web 服务。
2. 浏览器打开 wiki：首页能渲染、能登录、能打开编辑页（不保存）。首次请求可能较慢
   （模板编译/索引重建）。
3. 检查 `VERSION` 或管理页显示的版本是否正确。
4. 重建搜索索引：访问任意页面触发索引器，若服务器有 PHP CLI 可执行
   `php bin/indexer.php`；否则在 wiki 里浏览几页让 indexer 网页触发。
5. 用 `dsh-dokuwiki` 验证连通与权限：

   ```bash
   node scripts/smoke.mjs --url http://<wiki> --user <account>
   ```

   （在 dsh-dokuwiki 仓库里执行；或直接在 DSH 里调用 `wiki_status` 工具。）
6. 检查管理 → 插件/模板列表：旧插件若提示不兼容，逐个更新或停用
   （PHP 8.x 下旧代码常出现 `Deprecated` 警告，写日志但不一定影响功能）。
7. 检查日志：Apache/PHP 的 `error.log`，确认没有 `Fatal error`。

## 6. 回滚

```bash
sudo systemctl stop apache2
mv /path/to/dokuwiki /path/to/dokuwiki.failed
mv /path/to/dokuwiki.backup-<旧版本> /path/to/dokuwiki
sudo systemctl start apache2
```

回滚后清一下浏览器缓存再验证。

## 7. Windows 便携版（如 DokuWikiStick）特例

DokuWikiStick 是第三方打包的 Windows 便携版（Apache + PHP + DokuWiki 都在一个目录里）。
如果你用的是这类发行包：

- 结构通常是：`DokuWikiStick/dokuwiki`（程序+数据）、`DokuWikiStick/server`（Apache+PHP）、
  `run.cmd`（启动脚本）；
- 升级只替换 `dokuwiki/`，**不要动 `server/`**（Apache/PHP 保持原样）；
- 启动/停止：运行 `run.cmd`，或直接运行/结束 `server\mapache.exe`；日志在 `server/logs/`；
- 先确认便携版自带的 PHP 版本满足目标版本要求（例如 `2026-07-14c` 需要 PHP >= 8.2）；
  不满足时要升级便携版自带的 PHP 或改用其他部署方式。

## 8. 安全提醒

- 生产 wiki 先备份、先通知、再操作；不确定时先在一份拷贝上升级演练。
- 不要让 agent 在未确认的情况下执行 `rm`/覆盖/停服务；每条命令先展示再执行。
- 升级是**服务器运维**，与 `dsh-dokuwiki` 插件无关；插件只负责读写 wiki 内容。
