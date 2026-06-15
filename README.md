# @romatech/orm-providers-mysql

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
