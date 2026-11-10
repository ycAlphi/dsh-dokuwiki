# dsh-dokuwiki

[![npm version](https://img.shields.io/npm/v/dsh-dokuwiki.svg)](https://www.npmjs.com/package/dsh-dokuwiki)
[![test](https://github.com/ycAlphi/dsh-dokuwiki/actions/workflows/test.yml/badge.svg)](https://github.com/ycAlphi/dsh-dokuwiki/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/npm/l/dsh-dokuwiki.svg)](../../LICENSE)

[English](../README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的
**DokuWiki** 插件：用原生工具读取、搜索、写入、删除 wiki 页面，并上传媒体文件。
**任何能访问到的 DokuWiki 都行** —— 本地安装、局域网/子网内的 wiki、或公网网址；
账号配置在 DSH 官方的**「插件」页**里完成。密码存进 DSH 凭据服务，不写进插件配置
文件，也不会回显。

## 特性

- **原生工具** —— 模型直接调用 `wiki_read_page`、`wiki_search`、
  `wiki_write_page`、`wiki_upload_media` 等工具，不依赖外部脚本。
- **任意 DokuWiki 地址** —— 可配置多个 base URL（本地/内网/公网），按顺序尝试，
  第一个可用的生效。
- **两条 DokuWiki 访问路径都支持** —— 账号可走 XML-RPC 时用它读（页面列表、搜索、
  历史版本最完整）；写入、以及不能用 XML-RPC 的账号走浏览器同款表单登录 +
  `export_raw` / `edit` / `save`。
- **按 ACL 开放工具** —— 只有探测到账号有对应权限（编辑/上传）时才注册写入、删除、
  上传工具；每次调用仍由 wiki ACL 决定。`wiki_permissions` 支持**按命名空间**探测权限。
- **写入可验证** —— 每次保存后都回读校验，能识别 DokuWiki 的经典坑（`wikitext`
  字段缺失会被当作"取消编辑"而静默不保存）。
- **删除是显式操作并可验证** —— DokuWiki 里"保存空文本"等于删除页面，所以
  `wiki_write_page` 会拒绝空内容，只有 `wiki_delete_page` 能删除；删除要求填
  `summary`，并回读页面确认已消失。
- **上传可验证** —— 上传走媒体管理器接口，上传后回读并逐字节比对。
- **不会把账号锁死** —— 登录失败绝不自动重试：DokuWiki 连续失败会锁定约 15 分钟，
  且该锁定会连 XML-RPC 一起锁。
- **读取缓存** —— 页面读取缓存 5 分钟（`fresh: true` 可绕过），返回结果标明是否来自缓存。
- **自带 Skill** —— 插件注册 `dokuwiki` skill，把使用规则随插件一起交给模型。
- **可选的"按 wiki 定制写作规范"** —— wiki 可以把"新页面放哪、怎么命名、套哪个模板、
  必须有什么结构、摘要怎么写"写成普通 wiki 页面；在插件配置页填该页面 id 后，
  模型写入前会先用 `wiki_get_conventions` 读取并遵守。默认关闭。
- **最近改动** —— `wiki_recent_changes` 通过已登录会话读取 wiki 自己的 changelog（页面编辑
  与媒体上传，含日期/页面/用户/摘要），可按命名空间过滤，用来快速了解"最近改了什么"。
- **零运行时依赖** —— 纯 Node.js（内置 `fetch` + 小型 XML-RPC 编解码），无构建步骤、
  无原生模块、无 Python 依赖。

## 工具

| 工具 | 说明 |
|---|---|
| `wiki_status` | 连接、访问模式、登录状态，以及已探测到的账号权限 |
| `wiki_read_page` | 读取单个页面的 DokuWiki 源码（带短期缓存） |
| `wiki_get_conventions` | 读取本 wiki 自己的页面写作规范页（配置后才有） |
| `wiki_download_media` | 把 wiki 上的一个媒体文件下载到工作区（返回本地路径） |
| `wiki_list_pages` | 列出命名空间下的页面（`depth` 控制递归） |
| `wiki_search` | 全文搜索（XML-RPC，或网页搜索页兜底） |
| `wiki_recent_changes` | recent changes 里的最近页面/媒体改动（`limit`、命名空间过滤） |
| `wiki_page_history` | 历史版本列表（需要 XML-RPC 权限） |
| `wiki_can_edit` | 探测单个页面的编辑权限，探测后释放编辑锁 |
| `wiki_permissions` | 按命名空间探测读/创建/编辑/删除/上传权限 |
| `wiki_write_page` | 新建/编辑页面；`summary` 必填；保存后回读校验 |
| `wiki_delete_page` | 显式删除页面；`summary` 必填；回读确认已消失 |
| `wiki_upload_media` | 把工作区文件上传到指定命名空间；上传后下载回读校验 |

写入、删除、上传工具只在权限探测通过后才会注册；每次调用仍由 wiki ACL 校验。

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-dokuwiki
```

或在 DSH 的**「插件」页**里粘贴包名安装。DSH 会自动加载插件的
`cordis.patch.yml` 配置层。

## 配置

打开 **侧边栏 → 插件 → dsh-dokuwiki**，在本插件自己的配置页里填写：

1. **Base URL** —— 每行一个，按顺序尝试。本地安装（如
   `http://127.0.0.1:8080`）、局域网/子网内的 wiki（如
   `http://192.168.1.10:8080`）、公网地址（如 `https://wiki.example.com`）都支持；
   同一台 wiki 有多个入口时可以全部写上。
2. **用户名** —— DokuWiki 账号。
3. **密码** —— 保存到 DSH 凭据服务（`DOKUWIKI_PASSWORD`），不会写进配置文件，
   也不会回传给浏览器。
4. **测试连接** —— 实际登录、读取一页、探测编辑/上传权限并显示结果；
   探测后立即释放编辑锁。
5. **写作规范页（可选）** —— 填一个记录本 wiki 页面写作约定的页面 id；留空即关闭该功能。
   见下文。

非机密配置保存在 `$DSH_HOME/dokuwiki.config.json`。

## 写作规范（可选）

每个 wiki 都有自己的隐性写作规则：新页面放哪个命名空间、怎么命名、先套哪个模板页、
必须有哪些标题、编辑摘要怎么写。只看到通用工具描述的模型只能靠猜。

这个插件让 wiki 把这些约定写成**一个普通页面**：

1. 在 wiki 里建一页写作规范（例如 `wiki:conventions`）。页面要短、用命令式语气，
   尽量指向已有页面（模板页、字段格式页…），不要复制粘贴一堆会过期的内容。例如：

   ```dokuwiki
   ====== 页面写作规范 ======
     * 新页面放在：<命名空间>:<页面名>；不确定时先问用户。
     * 新建日志页：先套模板页 <模板页 id>，再填内容。
     * 图片：小写英文/数字/下划线命名，正文用 {{:...?direct&400|}} 缩略图。
     * 编辑摘要：中文、动词开头、说清改了什么。
     * 禁止：凭据、个人隐私、删除他人记录。
   ```

2. 在插件配置页填该页面 id（或改 `$DSH_HOME/dokuwiki.config.json` 里的
   `conventionsPage`）。插件使用的 wiki 账号必须**能读**该页面。
3. 模型在创建页面或大幅改写页面前会调用 `wiki_get_conventions` 并按返回内容执行
   （插件自带 skill 里写了这条规则）；页面不存在、读不到或功能关闭时，工具会如实
   说明，模型回退到用户指示。

该功能**完全可选、也不会拦截写入**：它只是把 wiki 自己的规则在模型要动手时递过去。
规范页会作为 prompt 内容出现，不要在里面写密码等敏感信息。

## 权限与 ACL

DokuWiki 没有把 ACL 暴露成可读的 API，所以插件用**网络探测**推断账号实际能做什么，
再据此只开放对应的工具：

| DokuWiki 权限 | 探测方式 | 开放的工具 |
|---|---|---|
| read | 读取一个已知页面；被拒绝说明不可读 | `wiki_read_page`、`wiki_list_pages`、`wiki_search`、`wiki_page_history` |
| edit | 打开探测页面的编辑表单；只有允许编辑时表单才会返回 | `wiki_write_page`（新建和编辑） |
| create | 对不存在的探测页面打开编辑表单 | 由 `wiki_write_page` 覆盖 |
| delete | 跟随编辑权限（DokuWiki 用保存空文本删页，没有独立的"页面删除"ACL 位） | `wiki_delete_page` |
| upload | 媒体管理器只在有 `AUTH_UPLOAD` 时渲染上传表单 | `wiki_upload_media` |
| 无权限 | 能登录但读页面被拒 | 只有 `wiki_status` 和 `wiki_permissions` |

工具注册是**账号级**的（启动时不可能探测所有命名空间），但权限可能按命名空间不同：
用 `wiki_permissions` 传入命名空间，可探测该命名空间的读/创建/编辑/删除/上传权限
（综合编辑表单探测、媒体管理器探测和页面读取）。每次工具调用仍由 DokuWiki 自己校验，
被拒绝时如实报错、不重试。

探测结果会在以下时机刷新：配置或密码变更、调用 `wiki_status`、以及最多每 60 秒一次。

## 媒体上传

`wiki_upload_media` 从工作区读取文件，通过媒体管理器接口上传，然后下载回读并逐字节比对。
注意：

- 目标命名空间默认 `user:<用户名>`，可用 `namespace` 指定别的；账号必须在目标命名空间有
  上传权限。
- 允许的文件类型由 wiki 决定（`conf/mime.conf` 和上传配置）。扩展名被拒绝时如实报错，
  请转换文件而不是反复重试。
- 插件侧上限 20 MiB；wiki/PHP 的限制可能更小。
- 不提供媒体删除工具，媒体管理留在 wiki 界面。

## 访问模式

| 模式 | 适用情况 | 读取 | 写入 |
|---|---|---|---|
| `rpc` | 账号可以使用 XML-RPC | XML-RPC：页面、列表、搜索、历史 | 网页表单登录 |
| `web` | XML-RPC 被拒或不可用 | `export_raw` + 渲染的索引/搜索页 | 网页表单登录 |

## 缓存

页面读取在插件内缓存 **5 分钟**（`fresh: true` 绕过）。本插件写入或删除某页时，该页的
缓存会立即失效；配置或密码变更时整个缓存清空。列表、搜索、历史不缓存。缓存的目的
是避免在一个多步任务里反复重取同一页——尤其在 `web` 模式下，每次读取都要经过登录会话。

## 环境要求

- DSH `>=0.2.0 <0.3.0`（通过 `engines.dsh` 声明；实际开发与验证版本为 `0.2.0-rc.2`）。
- Node.js `^22.19.0 || >=24.0.0`。
- DokuWiki `2024-02-06 "Kaos"` 或更新版本。已在 `2024-02-06b "Kaos"` 和
  `2026-07-14c "Mort"` 上验证（XML-RPC 与网页表单两种模式都测过）。
- **任意能访问到的 DokuWiki 都可以**：本地、局域网/子网、公网地址均可，只要运行 DSH 的
  机器能访问到（DSH 跑在你自己的电脑上，回环地址和内网地址都没问题）。

## 开发与测试

以下命令在仓库检出目录里运行（测试不会随 npm 包发布）。

```sh
npm test                      # 离线测试：mock DokuWiki 服务器 + 单元测试
npm run smoke -- --url <wiki> --user <账号> [--password <密码>]
npm run test:local -- --stick <便携版根目录>   # 可选，仅 Windows 便携版
```

**不需要本地 DokuWiki 也能测试**：

- **对任意 wiki 做只读 smoke test** —— 把 `scripts/smoke.mjs` 指向本地、局域网/子网
  或公网的 DokuWiki，给一个可读账号即可。它只读（连接、读页面、列命名空间、搜索、
  权限探测），不写任何东西：

  ```sh
  node scripts/smoke.mjs --url http://127.0.0.1:8080 --user my_account
  node scripts/smoke.mjs --url http://192.168.1.10:8080 --user my_account
  node scripts/smoke.mjs --url https://wiki.example.com --user my_account
  # 密码走环境变量，避免留在 shell 历史里：
  DOKUWIKI_PASSWORD=... node scripts/smoke.mjs --url https://wiki.example.com --user my_account
  ```

  `--page` 选择要读的页面（默认 `start`），`--query` 增加一次全文搜索检查。

- **写入/删除/上传测试需要一次性 wiki。** 离线测试已用 mock 服务器覆盖完整的
  写/删/上传流程；`test/local-integration.mjs` 会对一个一次性的 Windows 便携版
  （如 DokuWikiStick）跑同样流程（自动备份并恢复 wiki 配置、清理测试页面和媒体）。
  **不要对生产 wiki 跑破坏性测试。**

## 已知限制

- 不支持删除媒体文件（媒体管理留在 wiki 界面）。
- 删除对普通读者是永久的（DokuWiki 会在 attic 里保留历史版本，管理员可恢复）；
  目前没有额外的二次确认步骤。
- 工具可用性是按账号级探测的；命名空间级差异由 `wiki_permissions` 报告、由 wiki 自身执行。
- 一个插件实例只支持一个 wiki 账号。

## 文档

- [DokuWiki 升级操作指南](upgrade-dokuwiki.md) —— 自建 DokuWiki 的安全升级
  runbook（备份、替换程序文件、保留 `conf/` 与 `data/`、验证、回滚），命令可直接复制。
  插件**刻意不提供**升级功能：升级是服务器运维操作，需要 shell 权限、维护窗口和备份方案，
  应该由 wiki 管理员执行，而不是由客户端插件修改服务器。
- [插件发布指南](publish.md) —— GitHub + npm 发布流程（维护者手册）。

## 许可证

MIT
