# @romatech/orm-providers-mysql

[![npm](https://img.shields.io/npm/v/@romatech%2Form-providers-mysql)](https://www.npmjs.com/package/@romatech/orm-providers-mysql)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/RomaTech-LTDA/orm-providers-mysql/blob/main/LICENSE)

<p align="center">
  <img src="logo.png" width="120" alt="RomaTech ORM – MySQL Provider" />
</p>

MySQL / MariaDB provider for [@romatech/orm](https://www.npmjs.com/package/@romatech/orm).

---

## Installation

```bash
npm install @romatech/orm @romatech/orm-providers-mysql reflect-metadata
```

---

## Quick Start

```ts
import 'reflect-metadata';
import { DbContext, DbContextOptions } from '@romatech/orm';
import { MySqlProvider } from '@romatech/orm-providers-mysql';

class AppDbContext extends DbContext {
    users = this.set(User);

    constructor() {
        super(
            new DbContextOptions().useProvider(
                new MySqlProvider({
                    host: 'localhost',
                    port: 3306,
                    user: 'root',
                    password: 'yourPassword',
                    database: 'mydb'
                })
            )
        );
    }
}
```

---

## Configuration Options

### Object-style (recommended)

```ts
new MySqlProvider({
    host: 'localhost',
    port: 3306,           // optional, defaults to 3306
    user: 'root',
    password: 'yourPassword',
    database: 'mydb'
})
```

### Connection string

```ts
new MySqlProvider('mysql://root:password@localhost:3306/mydb')
```

---

## SQL Dialect

| Feature | Syntax |
|---------|--------|
| Identifier quoting | `` `columnName` `` |
| Parameters | `?` (positional) |
| IF NOT EXISTS | `CREATE TABLE IF NOT EXISTS` |

---

## Supported Features

- Full CRUD (add, addRange, update, remove, removeRange, find, getAll)
- Server-side WHERE clause generation from predicates
- Server-side ORDER BY generation
- Migration history table (`` `__roma_migrations` ``)
- Schema management (createTable, dropTable, addColumn, removeColumn)
- Scaffold (introspect via `INFORMATION_SCHEMA.COLUMNS` and `SHOW TABLES`)
- Parameterised queries (SQL injection safe)
- Transactions through `DbContext.beginTransaction()` (since 2.1.0; in 2.0.0 the
  `BEGIN` statement failed with `ER_UNSUPPORTED_PS`)

### Notes

- The provider uses **one connection**: a transaction covers every statement
  sent through the provider meanwhile, so use one `DbContext` per unit of work
  when requests run concurrently.
- `update`, `remove` and `find` locate the row by the table's single-column
  primary key (or `id` when the table has none). Tables with a **composite**
  primary key are rejected with an error, instead of matching every row that
  shares the first key column.
- The primary key of each table is introspected once and cached. The cache is
  cleared after the provider's own DDL and after raw statements that are not
  `SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`; call
  `provider.clearMetadataCache()` if another process changes the schema while
  the provider is connected.
- Query predicates are evaluated by MySQL and then re-checked in JavaScript on
  converted copies of the rows: `BOOLEAN`/`TINYINT(1)` and `BIT(1)` are
  compared as booleans (so `x => x.active === true` works), `DECIMAL` and
  `BIGINT` strings as numbers, and date strings (`dateStrings` option) as
  `Date`. The rows you get back are the driver's rows, unchanged. A
  comparison of a date column with a string literal
  (`x => x.createdAt >= '2024-01-01'`) is left to MySQL. A `TINYINT(1)` used
  for small integers is therefore compared as a boolean in predicates; use
  `TINYINT` (or a wider type) for numbers.

---

## Type Mappings

| TypeScript Type | MySQL Type |
|-----------------|------------|
| `number` (PK) | `INT` |
| `number` | `DOUBLE` |
| `boolean` | `BOOLEAN` |
| `Date` | `DATETIME` |
| `string` | `VARCHAR(255)` |
| `unknown` | `JSON` |

---

## Requirements

- Node.js >= 18
- MySQL 5.7+ or MariaDB 10.2+
- The [`mysql2`](https://www.npmjs.com/package/mysql2) npm package (installed automatically)

---

## License

MIT © RomaTech / Leandro Romanelli
