# Changelog

All notable changes to @romatech/orm-providers-mysql will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.1.0] - 2026-11-11

### Fixed
- Transactions: statements without parameters use the text protocol (`query()`), so `BEGIN`/`ROLLBACK` (sent by `DbContext.beginTransaction()` and `Transaction`) no longer fail with `ER_UNSUPPORTED_PS`; transactions never worked in 2.0.0. Statements with parameters still use prepared statements; nothing is interpolated.
- Query predicates re-checked in JavaScript run on copies of the rows converted to the entity's types: `BOOLEAN`/`TINYINT(1)` and `BIT(1)` as booleans, `DECIMAL` and `BIGINT` strings as numbers, date strings as `Date`. `where(x => x.active === true)` or `where(x => x.price === 12.5)` returned no rows although MySQL matched them, and `DECIMAL` columns sorted as strings client-side. A predicate MySQL already applied that compares a date column with a string literal is no longer re-checked (always false in JS). The returned rows are unchanged driver rows. Predicates written against the driver's own values in 2.0.0 style (for example `x.active === 1` or `x.id === '5'`) keep matching the rows the database returned: when the database already applied the predicate, a row is kept if it holds on either the converted or the original value.
- `update`/`remove`/`find` throw for tables with a composite primary key instead of matching rows by the first key column only (removing one order line deleted every line of the order).
- `getColumnsForTable` filters by `DATABASE()`; with a connection-string config it mixed in the columns and primary key of same-named tables in every database on the server.
- `update` with only `undefined` values besides the key is a no-op instead of sending invalid SQL (`SET  WHERE`).

### Changed
- The primary key of each table is introspected once and cached (`update`/`remove`/`find` cost one round trip instead of two). The cache is cleared after the provider's DDL, after raw statements other than `SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`, and by the new `clearMetadataCache(tableName?)`.
- CI: `npm ci` (the lockfile had drifted to `@romatech/orm@1.2.0`; re-synced), Node 22 and 24, read-only `permissions`. The publish workflow uses `npm ci` and no longer rewrites the `@romatech/orm` range with `sed` before publishing; the GitHub release runs in a separate job with `contents: write`.
- `npm test` (Node test runner): unit tests, plus integration tests against a real MySQL when `MYSQL_TEST_URL` is set.
- Standardized `index.html` landing page (GitHub Pages).

## [2.0.0]

Published to npm without a changelog entry (see the git history). The versions on npm are 1.0.0, 1.3.0 and 2.0.0; the 1.2.0 entry below was never published under that number.

## [1.2.0] - 2026-06-18

### Added
- Initial release
