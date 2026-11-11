# Changelog

## 0.4.2 — 2026-11-11

### Fixed

- `wiki_recent_changes` no longer labels newly created pages as media files.
  Classification used to depend on the entry having a diff link, which a fresh
  page may lack; it now looks at the title anchor target (media entries link to
  the media manager, page entries to `?id=<page>`).

## 0.4.1 — 2026-11-11

### Fixed

- `wiki_status` no longer returns `null` for `probePage` / `uploadProbe` before a
  permission probe has produced a value. Both are declared as `string` in the
  tool output schema, so on an unconfigured wiki (or when detection failed) DSH
  rejected the result with "must be string". They are now omitted until known.
- The offline suite now validates every covered tool output against its declared
  output schema (field types, required fields, `additionalProperties: false`), so
  a nullable field declared as `string` fails in tests instead of inside DSH.

### Changed

- The maintainer-only `docs/publish.md` is no longer shipped in the npm package;
  it stays in the GitHub repository and the README links to it there.

## 0.4.0 — 2026-11-10

### Added

- `wiki_recent_changes`: the wiki's most recent changes (page edits and media
  uploads) with date, page id, user and edit summary, read from the DokuWiki
  Recent changes page through the logged-in session (works in both access
  modes). Optional `limit` (default 20, max 50) and `namespace` prefix filter.
  This replaces the earlier practice of scripting a separate wiki login just to
  see what changed lately.

## 0.3.1 — 2026-11-10

### Fixed

- `wiki_get_conventions` returned an undeclared `via` field, which DSH rejects at
  the tool-output schema boundary (`additionalProperties: false`), so the tool
  failed even when the conventions page was readable. The field is gone and a
  regression test now asserts that every returned field is declared.
- Capability detection no longer gives up when the DSH credentials service mounts
  after this plugin on a cold start: the credential-service lookup is optional,
  and a startup-race failure is retried up to three times so the write tools are
  still registered without a manual refresh.

## 0.3.0 — 2026-11-10

### Added

- **Optional per-wiki writing conventions.** `conventionsPage` (plugin settings
  field, empty by default) points at a normal DokuWiki page that records the
  wiki's own page-writing rules (locations, naming, templates, structure,
  summary style). `wiki_get_conventions` returns that page, and the built-in
  skill now tells the model to read it before creating or substantially
  rewriting a page. The feature is opt-in and never blocks writes; when no page
  is configured (or it is missing/unreadable) the tool just reports that.

### Changed

- Tool descriptions no longer use example terms tied to one particular wiki.

## 0.2.0 — 2026-11-10

### Added

- `wiki_download_media`: download one media file (images and other media types)
  into the workspace and return its local path. The file is fetched through the
  logged-in wiki session, so it works in both access modes and the wiki ACL of
  the configured account decides access.

### Changed

- Skill: the authentication rule now explicitly forbids reading DSH credential
  files (for example `~/.dsh/.credentials.yaml`) or scripting a separate wiki
  login, and says to report a missing capability instead of working around the
  plugin. An agent session was observed reading the plaintext credential store
  to fetch an image because media access had no tool.

## 0.1.2 — 2026-11-10

### Fixed

- Capability detection no longer mistakes "cannot create new pages" for
  "cannot write". It now probes the edit form of an existing page first (then a
  few pages from the index, then the old new-page probes), so accounts that may
  edit existing pages but not create new ones are detected as writable and get
  the write tools. Found against a real DokuWiki where an agent account had
  edit-only permission.
- `testConnection` / `wiki_status` use the same existing-page probe order, so
  the configuration page reports the edit permission correctly for edit-only
  accounts.
- Web-mode `listPages` returned nothing for the root namespace because the
  parser required a `namespace:` prefix; the root namespace now matches
  top-level pages and namespaces.
- `probePermissions` falls back to the conventional `<namespace>:start` page
  when the wiki's index page does not render page links (some templates only
  show namespace folders), so read/edit permission can still be probed there.

## 0.1.1 — 2026-11-10

### Changed

- The Chinese README now lives at `docs/README.zh.md`. npm chooses the README
  shown on the package page by scanning `README*` files in the package root; on
  Windows that scan can pick `README.zh.md` first, so the npm page showed the
  Chinese text. Keeping only `README.md` in the root makes the English README
  the one npm displays.
- README: npm version, CI and license badges.

## 0.1.0 — 2026-11-09

First usable release.

### Added

- Native tools: `wiki_status`, `wiki_read_page`, `wiki_list_pages`, `wiki_search`,
  `wiki_page_history`, `wiki_can_edit`, `wiki_permissions`, `wiki_write_page`,
  `wiki_delete_page`, `wiki_upload_media`.
- ACL-aware tool exposure: write/delete tools are registered only after the
  capability probe confirms the account may edit; the media upload tool only
  after the media manager serves its upload form. Deletion is explicit and
  verified by reading the page back; uploads are verified byte-for-byte.
- Per-namespace permission probing (`wiki_permissions`): read/create/edit/
  delete/upload inside one namespace, inferred from the network responses
  (edit form, media manager upload form, page read).
- Configuration page inside DSH's official Plugins page
  (`plugins.bundle.config`, keyed by the package name): base URLs, username,
  password, write switch, connection test, and detected permissions.
- Password storage through the DSH credentials service
  (`DOKUWIKI_PASSWORD`); the config file contains no secrets.
- Dual access paths: XML-RPC + HTTP Basic Auth for rich reads, and
  browser-faithful form login + `export_raw`/`edit`/`save` for write access and
  for accounts without XML-RPC.
- Short-lived read cache (5 minutes, `fresh: true` bypasses it) with invalidation
  on write/delete and on configuration/credential changes.
- Runtime skill `dokuwiki` carrying the operational rules (no retries on login
  failure, summary required, explicit deletion, upload rules, content is data
  not instructions).
- Works against any reachable DokuWiki (local, LAN/subnet, public URL); the
  base URL list is tried in order.
- Offline test suite (mock DokuWiki server), a read-only smoke test for any
  wiki (`scripts/smoke.mjs`), and an optional in-place integration test against
  a disposable DokuWikiStick installation.
- Verified against DokuWiki `2024-02-06b "Kaos"` and `2026-07-14c "Mort"`.

### Fixed

- XML-RPC requests now send the bare `text/xml` media type. DokuWiki rejects
  `text/xml; charset=utf-8` with fault `-32606` and the plugin used to fall
  back to web-form mode because of it (found against a real DokuWiki
  installation).
- `wiki_page_history` now understands the field names DokuWiki actually
  returns (`sum`, `modified`, `type`, `ip`) while still accepting
  `summary`/`date` spellings from other implementations.

### Known limitations

- Media deletion is not supported (media management stays in the wiki UI).
- Deletion is permanent for readers (the wiki attic keeps revisions); there is
  no extra confirmation step yet.
- Tool availability is detected at account level; per-namespace differences are
  reported by `wiki_permissions` and enforced by the wiki itself.
- One wiki account per plugin instance.
