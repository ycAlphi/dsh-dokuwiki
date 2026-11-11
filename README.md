# dsh-dokuwiki

[![npm version](https://img.shields.io/npm/v/dsh-dokuwiki.svg)](https://www.npmjs.com/package/dsh-dokuwiki)
[![test](https://github.com/ycAlphi/dsh-dokuwiki/actions/workflows/test.yml/badge.svg)](https://github.com/ycAlphi/dsh-dokuwiki/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/npm/l/dsh-dokuwiki.svg)](LICENSE)

English | [中文](docs/README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for
**DokuWiki**: read, search, write and delete wiki pages and upload media files
through native tools. It works with any reachable DokuWiki — a local install, a
wiki on the LAN, or a public URL — and the account setup lives on DSH's official
**Plugins** page. The password is stored in DSH's credential service, never in
the plugin config.

## Features

- **Native tools** — the model calls `wiki_read_page`, `wiki_search`,
  `wiki_write_page`, `wiki_upload_media`, … instead of shelling out to an
  external script.
- **Any DokuWiki endpoint** — one or more base URLs (local/LAN/public) are tried
  in order; the first reachable one wins.
- **Both DokuWiki access paths** — XML-RPC + HTTP Basic Auth for rich reads
  (page lists, search, history), and a browser-faithful form login +
  `export_raw` / `edit` / `save` path for writes and for accounts that are not
  allowed to use XML-RPC.
- **ACL-aware tool exposure** — write/delete/upload tools are only offered when
  the account is detected to have the matching permission; the wiki ACL still
  decides every call. `wiki_permissions` probes permissions **per namespace**.
- **Honest writes** — every save is verified by reading the page back; the known
  DokuWiki trap (a missing `wikitext` field is treated as "cancel editing" and
  silently does nothing) is detected and reported.
- **Explicit, verified deletion** — saving empty text deletes a page in
  DokuWiki; `wiki_write_page` rejects empty bodies so that only
  `wiki_delete_page` can delete, and deletion requires a summary and is verified
  by reading the page back.
- **Media discovery, read and write** — `wiki_list_media` browses a media
  namespace through the logged-in session (the media manager itself requires a
  login), `wiki_download_media` fetches one file into the workspace, and uploads
  go through the media manager endpoint and are verified by downloading the
  stored file byte-for-byte.
- **No accidental lockout** — a failed login is never retried automatically;
  DokuWiki locks the account after repeated failures and that lock also blocks
  XML-RPC.
- **Read cache** — page reads are cached for five minutes (`fresh: true`
  bypasses it) and the result says whether it came from cache.
- **Built-in skill** — a `dokuwiki` skill ships with the plugin and carries the
  operational rules, so the model knows when and how to use the tools.
- **Session-scoped lazy tools** — only `wiki_status` is offered up front. The
  remaining tools are registered for a conversation when that conversation loads
  the `dokuwiki` skill, in that Agent's own scope; other sessions never see them.
  Switch it off to always expose the full tool set.
- **Optional per-wiki writing conventions** — a wiki can record its own rules
  (where new pages go, how they are named, which template to copy, required
  structure, summary style) in a normal wiki page. Set that page id on the
  plugin configuration page and the model reads it with
  `wiki_get_conventions` before writing. Off by default.
- **Recent changes** — `wiki_recent_changes` reads the wiki's own changelog
  (page edits and media uploads, with date/page/user/summary) through the
  logged-in session, optionally filtered by namespace.
- **Zero runtime dependencies** — plain Node.js (`fetch` + a small XML-RPC
  codec). No build step, no native modules.

## Tools

| Tool | Description |
|---|---|
| `wiki_status` | Connection, access mode, login, and the account permissions detected so far |
| `wiki_read_page` | Raw DokuWiki source of one page (short-lived cache) |
| `wiki_get_conventions` | The wiki's own page-writing conventions page, when configured |
| `wiki_download_media` | Download one media file into the workspace (returns the local path) |
| `wiki_list_media` | List media files directly inside one media namespace (media discovery; the media manager needs a login) |
| `wiki_list_pages` | List pages in a namespace (`depth` controls recursion) |
| `wiki_search` | Full-text search (XML-RPC, or the wiki search page as fallback); returns page titles and snippets |
| `wiki_recent_changes` | Recent page/media changes from the changelog page (`limit`, namespace filter) |
| `wiki_page_history` | Revision list (requires XML-RPC access) |
| `wiki_can_edit` | Probe edit permission for one page; releases the edit lock |
| `wiki_permissions` | Probe read/create/edit/delete/upload permission for one namespace |
| `wiki_write_page` | Create/edit a page; `summary` required; readback-verified |
| `wiki_delete_page` | Delete a page (explicit); `summary` required; verified by readback |
| `wiki_upload_media` | Upload a workspace file into a namespace; verified by downloading it back |

In the default **lazy** mode only `wiki_status` is offered up front; loading the
`dokuwiki` skill unlocks the rest for that conversation (the tools are
registered in the Agent's own scope, so other sessions are unaffected). With
`lazyTools: false` every read tool is exposed from the start. Write, delete and
upload tools are registered only after the capability probe confirms the
account may use them; the wiki ACL still decides every call.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-dokuwiki
```

or install it from DSH's **Plugins** page (paste the package name). DSH loads
the plugin's `cordis.patch.yml` layer automatically.

## Configure

Open **Plugins → dsh-dokuwiki** (the configuration page rendered by this
plugin) and fill in:

1. **Base URL(s)** — one per line, tried in order. A local install
   (`http://127.0.0.1:8080`), a wiki on the LAN
   (`http://192.168.1.10:8080`) and a public address
   (`https://wiki.example.com`) all work the same way; list several if the wiki
   is reachable from more than one place and the first reachable one is used.
2. **Username** — the DokuWiki account.
3. **Password** — stored in DSH's credential service under `DOKUWIKI_PASSWORD`;
   it is never written to this plugin's config file and never sent back to the
   browser.
4. **Test connection** — logs in, reads a page, probes edit/upload permissions,
   and reports the detected permissions. The probe releases the edit lock
   immediately.
5. **Writing conventions page** (optional) — a DokuWiki page id that records this
   wiki's own page-writing rules; leave it empty to keep the feature off. See
   below.
6. **Session-scoped lazy tools** (on by default) — only `wiki_status` is
   offered up front; the rest of the tool set is registered for a conversation
   when that conversation loads the `dokuwiki` skill. Turn it off to always
   expose the full tool set. This switch takes effect after DSH restarts or the
   plugin is re-enabled.

Non-secret settings are stored in `$DSH_HOME/dokuwiki.config.json`.

## Writing conventions (optional)

Every wiki has implicit writing rules: which namespace new pages go to, how they
are named, which template page to copy, which headings are expected, what an edit
summary should say. An agent that only sees generic tool descriptions has to
guess them.

The plugin lets the wiki carry those rules as a normal DokuWiki page instead:

1. Create a wiki page with the rules (for example `wiki:conventions`). Keep it
   short and imperative, and point to existing pages instead of duplicating them
   (template page, data-format page, …). Example skeleton:

   ```dokuwiki
   ====== 页面写作规范 ======
     * 新页面放在：<命名空间>:<页面名>；不确定时先问用户。
     * 新建日志页：先套模板页 <模板页 id>，再填内容。
     * 图片：小写英文/数字/下划线命名，正文用 {{:...?direct&400|}} 缩略图。
     * 编辑摘要：中文、动词开头、说清改了什么。
     * 禁止：凭据、个人隐私、删除他人记录。
   ```

2. Set that page id in the plugin settings (or `conventionsPage` in
   `$DSH_HOME/dokuwiki.config.json`). The configured wiki account must be able to
   read the page.
3. Before creating or substantially rewriting a page, the model calls
   `wiki_get_conventions` and follows what it returns (the built-in skill says to
   do so). If the page is missing or unreadable — or the feature is off — the
   tool says so and the model falls back to the user's instructions.

The feature is **opt-in and never blocks writes**: it only makes the wiki's own
rules available at the moment the model decides to write. The page is
prompt-visible content, so keep secrets out of it.

## Permissions and ACL

DokuWiki does not expose its ACL through an API, so the plugin **infers**
what the configured account may do from the network responses, then exposes only
the tools that make sense:

| DokuWiki permission | How it is detected | What the plugin exposes |
|---|---|---|
| read | read a known page; a permission-denied answer means no read | `wiki_read_page`, `wiki_list_pages`, `wiki_search`, `wiki_page_history` |
| edit | open the edit form for a probe page — the form is only served when the account may edit | `wiki_write_page` (create and edit) |
| create | same edit-form probe on a non-existent probe page | covered by `wiki_write_page` |
| delete | follows edit permission (DokuWiki deletes by saving empty text; there is no separate page-delete ACL bit) | `wiki_delete_page` |
| upload | the media manager page only renders its upload form with `AUTH_UPLOAD` | `wiki_upload_media` |
| none | login works but page reads are denied | only `wiki_status` and `wiki_permissions` |

Tool registration is **account-level** because probing every namespace at
startup is not practical, but permissions can differ per namespace. Use
`wiki_permissions` with a namespace id to probe read/create/edit/delete/upload
in that namespace (it combines the edit-form probe, the media-manager probe and
a page read). Every tool call is still checked by DokuWiki itself, and a denial
is reported instead of retried.

The probe is refreshed when the configuration or password changes, when
`wiki_status` is called, and at most every 60 seconds.

## Media

DokuWiki only exposes media listings to a logged-in session — anonymous requests
to the media manager are refused — so `wiki_list_media` lists one namespace
through the plugin's session (files plus direct sub-namespaces; walk them
yourself for a tree). `wiki_download_media` fetches one media file (image etc.)
through `fetch.php` using the same session and writes it into the workspace
(default `wiki_media/<basename>`). `wiki_upload_media` reads a file from the
workspace, uploads it through the media manager endpoint, and verifies it by
downloading the stored file and comparing the bytes. Notes:

- Downloads are capped at 20 MiB; `dest_path` must stay inside the workspace.
- The upload namespace defaults to `user:<username>`; pass `namespace` to use
  another one. The account must have upload permission there.
- Which file types are allowed is decided by the wiki (`conf/mime.conf` and its
  upload settings). A rejected extension is reported as-is; convert the file
  instead of retrying.
- Files are capped at 20 MiB by the plugin; the wiki/PHP limit may be lower.
- There is no media-delete tool; media management stays in the wiki UI.

## Access modes

| Mode | When | Reads | Writes |
|---|---|---|---|
| `rpc` | The account may use XML-RPC | XML-RPC: page, list, search, history | Web form login |
| `web` | XML-RPC denied or unavailable | `export_raw` + rendered index/search pages | Web form login |

In `web` mode the page listing is parsed from the wiki's index page. Some
templates only render namespace folders there and hide page links; in that case
`wiki_list_pages` returns nothing (search still works). Enabling XML-RPC for the
account (`$conf['remote'] = 1; $conf['remoteuser'] = '<user>';`) gives complete
listing, history and faster reads.

## Caching

Page reads are cached in the plugin for **5 minutes** (`fresh: true` bypasses
the cache). The cache entry for a page is dropped when the plugin writes or
deletes that page, and the whole cache is dropped when the configuration or the
credential changes. List, search and history are never cached. The point is to
avoid refetching the same page two or three times in a single multi-step task —
especially in `web` mode, where every read goes through a login session.

## Requirements

- DSH `>=0.2.0 <0.3.0` (declared via `engines.dsh`; developed and verified
  against DSH `0.2.0-rc.2`).
- Node.js `^22.19.0 || >=24.0.0`.
- DokuWiki `2024-02-06 "Kaos"` or later. Verified against `2024-02-06b "Kaos"`
  and `2026-07-14c "Mort"`, in both XML-RPC and web-form mode.
- Any reachable DokuWiki works: local, LAN, subnet or public URL. It must be
  reachable from the machine running DSH (`dsh` runs on your own computer, so
  loopback and LAN addresses are fine).

## Development and testing

Run these from a repository checkout (tests are not included in the npm package).

```sh
npm test                      # offline suite: mock DokuWiki server + unit tests
npm run smoke -- --url <wiki> --user <account> [--password <password>]
npm run test:local -- --stick <portable wiki root>   # optional, Windows portable builds
```

There is **no need for a local DokuWiki** to test this plugin:

- **Read-only smoke test against any wiki** — point `scripts/smoke.mjs` at a
  local, LAN/subnet or public DokuWiki and give it an account. It only reads
  (connect, page read, namespace list, search, permission probes) and never
  writes:

  ```sh
  node scripts/smoke.mjs --url http://127.0.0.1:8080 --user my_account
  node scripts/smoke.mjs --url http://192.168.1.10:8080 --user my_account
  node scripts/smoke.mjs --url https://wiki.example.com --user my_account
  # password via env to keep it out of shell history:
  DOKUWIKI_PASSWORD=... node scripts/smoke.mjs --url https://wiki.example.com --user my_account
  ```

  `--page` selects the page to read (default `start`), `--query` adds a
  full-text search check.

- **Write/delete/upload tests need a disposable wiki.** The offline suite covers
  the full write/delete/upload flow against a mock server; `test/local-integration.mjs`
  runs the same flow against a throwaway portable DokuWiki install (e.g.
  DokuWikiStick; it backs up and restores the wiki config and removes test
  pages/media). Never point the
  destructive test at a production wiki.

## Limitations

- Media deletion is not supported (management stays in the wiki UI).
- Deletion is permanent for readers (DokuWiki keeps revisions in its attic, and
  a wiki admin can restore from there). No extra confirmation step is built in
  yet.
- Tool availability is detected at account level by probing an existing page's
  edit form (an account that may edit pages but not create new ones is detected
  as writable); per-namespace differences are reported by `wiki_permissions`
  and enforced by the wiki itself.
- One wiki account per plugin instance.

## Docs

- [Upgrading DokuWiki](docs/upgrade-dokuwiki.md) — administrator runbook for a
  safe in-place upgrade (backup, replace program files, keep `conf/` + `data/`,
  verify, rollback). Written in Chinese, commands are copy-pasteable.
  The plugin deliberately does **not** upgrade the wiki server itself: that is a
  server-side operation which belongs to the wiki administrator, not to a client
  plugin (and it needs shell access, a maintenance window and a backup plan).
- [Publishing this plugin](https://github.com/ycAlphi/dsh-dokuwiki/blob/main/docs/publish.md)
  — maintainer guide for the GitHub + npm release flow (Chinese). It lives in
  the repository only and is not shipped in the npm package.

## License

MIT
