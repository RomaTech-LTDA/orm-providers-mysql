/**
 * @module mysql-provider
 *
 * MySQL / MariaDB implementation of {@link IDbProvider}.
 *
 * Uses the [`mysql2`](https://www.npmjs.com/package/mysql2) package with
 * promise-based connections.
 *
 * SQL Dialect:
 * - Identifiers quoted with backticks: `` `columnName` ``
 * - Positional parameters: `?`
 * - `CREATE TABLE IF NOT EXISTS` for idempotent DDL
 */

import mysql from 'mysql2/promise';
import {
  buildDeleteSql,
  buildFindSql,
  buildInsertSql,
  buildSelectAllSql,
  buildSelectSql,
  buildUpdateSql,
  IDbProvider,
  QueryObject,
  SqlDialect,
  TableColumnInfo
} from '@romatech/orm';
import { applyQueryToDriverRows, DriverColumns, toBoolean, toDate, toNumber, ValueConverter } from './driver-rows';

/** Raw statements that cannot change the schema (they keep the key cache). */
const READ_ONLY_STATEMENT = /^\s*(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;

/**
 * Configuration object for a MySQL / MariaDB connection.
 *
 * Accepts either a connection URI string or a structured object.  The object
 * form is preferred in production environments as it avoids credential leakage
 * through string interpolation.
 *
 * @example
 * // URI / connection string form
 * const config: MySqlConfig = 'mysql://user:secret@localhost:3306/mydb';
 *
 * @example
 * // Object form
 * const config: MySqlConfig = {
 *   host: 'localhost',
 *   port: 3306,
 *   user: 'app_user',
 *   password: 'secret',
 *   database: 'mydb'
 * };
 */
type MySqlConfig = string | {
  /** Hostname or IP address of the MySQL/MariaDB server. */
  host: string;
  /** TCP port (default: 3306). */
  port?: number;
  /** MySQL login name. */
  user: string;
  /** MySQL login password. */
  password: string;
  /** Target database (schema) name. */
  database: string;
};

/**
 * SQL dialect definition for MySQL / MariaDB.
 *
 * - **Identifier quoting**: wraps identifiers in backticks (`` `name` ``) and
 *   escapes embedded backticks by doubling them (` `` `), following the MySQL
 *   quoting convention.
 * - **Parameter style**: always returns `'?'` regardless of index.  The
 *   `mysql2` driver uses positional `?` placeholders and expects parameters
 *   supplied in the same order.
 */
const dialect: SqlDialect = {
  quoteIdentifier: identifier => `\`${identifier.replace(/`/g, '``')}\``,
  parameter: () => '?'
};

/**
 * RomaTech ORM database provider for **MySQL** and **MariaDB**.
 *
 * Uses the `mysql2/promise` driver for async/await support.  A single
 * connection object is maintained per provider instance.  All DML and DDL
 * statements use parameterized queries with positional `?` placeholders to
 * prevent SQL injection.
 *
 * Implements {@link IDbProvider} — the common interface shared by all
 * RomaTech ORM providers.
 *
 * @example
 * import { MySqlProvider } from '@romatech/orm-providers-mysql';
 * import { DbContext, entity, primaryKey } from '@romatech/orm';
 *
 * \@entity('products')
 * class Product {
 *   \@primaryKey()
 *   id!: number;
 *   name!: string;
 *   price!: number;
 * }
 *
 * const provider = new MySqlProvider({
 *   host: 'localhost',
 *   user: 'root',
 *   password: 'secret',
 *   database: 'shop'
 * });
 *
 * const ctx = new DbContext(provider);
 * await ctx.connect();
 * const products = ctx.set(Product);
 * await products.addAsync({ id: 1, name: 'Widget', price: 9.99 });
 * await ctx.disconnect();
 */
export class MySqlProvider implements IDbProvider {
  /** The `mysql2` connection used for all database operations. */
  private connection!: any;

  /** Primary-key columns per table, so DML does not introspect on every call. */
  private readonly primaryKeyCache = new Map<string, Promise<string[]>>();

  /**
   * Creates a new `MySqlProvider` instance.
   *
   * The TCP connection is not established until {@link connect} is called.
   *
   * @param config - Either a connection URI string or a structured
   *   {@link MySqlConfig} object.
   */
  constructor(private config: MySqlConfig) {}

  /**
   * Opens a connection to the MySQL / MariaDB server.
   *
   * When `connectionString` is supplied it takes precedence over the config
   * passed to the constructor, allowing the ORM framework to inject a runtime
   * connection string (e.g., from environment variables).
   *
   * @param connectionString - Optional override connection URI.
   * @returns A promise that resolves when the connection is ready.
   * @throws {Error} If the server is unreachable or credentials are invalid.
   *
   * @example
   * await provider.connect();
   * await provider.connect('mysql://user:pass@prod-host/mydb');
   */
  async connect(connectionString = ''): Promise<void> {
    this.connection = await mysql.createConnection(connectionString || this.config);
  }

  /**
   * Closes the connection to the MySQL / MariaDB server.
   *
   * Sends a graceful `COM_QUIT` packet to the server before closing the socket.
   *
   * @returns A promise that resolves once the connection is closed.
   *
   * @example
   * await provider.disconnect();
   */
  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.end();
    }
  }

  /**
   * Inserts a single entity into the specified table.
   *
   * Delegates to {@link buildInsertSql} which produces
   * `` INSERT INTO `tableName` (`col1`, `col2`, …) VALUES (?, ?, …) ``.
   * Properties with `undefined` values are omitted so that column defaults
   * (e.g. `AUTO_INCREMENT`, `DEFAULT CURRENT_TIMESTAMP`) are respected.
   *
   * @param entity - Plain object whose own enumerable properties map to
   *   table columns.
   * @param tableName - Target table name (will be backtick-quoted).
   * @returns A promise that resolves when the row has been inserted.
   * @throws {Error} On constraint violations (duplicate entry, NOT NULL, etc.).
   *
   * @example
   * await provider.add({ id: 1, name: 'Widget', price: 9.99 }, 'products');
   */
  async add<T extends object>(entity: T, tableName: string): Promise<void> {
    const command = buildInsertSql(tableName, entity, dialect);
    await this.run(command.sql, command.params);
  }

  /**
   * Inserts multiple entities into the specified table sequentially.
   *
   * @param entities - Array of entities to insert.
   * @param tableName - Target table name.
   * @returns A promise that resolves when all rows have been inserted.
   * @throws {Error} If any individual insert fails; previous inserts within
   *   the same call are not rolled back automatically.
   *
   * @example
   * await provider.addRange(
   *   [{ id: 1, name: 'A' }, { id: 2, name: 'B' }],
   *   'products'
   * );
   */
  async addRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    for (const entity of entities) {
      await this.add(entity, tableName);
    }
  }

  /**
   * Updates an existing row identified by its primary key.
   *
   * Introspects column metadata to determine the primary key, then generates
   * `` UPDATE `tableName` SET `col1` = ?, … WHERE `pk` = ? ``.
   * If the entity contains only the primary-key field, the operation is
   * skipped (nothing to update).
   *
   * @param entity - Object whose primary-key property identifies the row and
   *   remaining properties supply the new values.
   * @param tableName - Target table name.
   * @returns A promise that resolves when the row has been updated.
   * @throws {Error} If no matching row exists or a constraint is violated.
   *
   * @example
   * await provider.update({ id: 1, price: 12.50 }, 'products');
   */
  async update<T extends object>(entity: T, tableName: string): Promise<void> {
    const primaryKey = await this.getPrimaryKeyColumn(tableName);
    // Guard: skip the round-trip if there are no columns to update besides the PK
    // (undefined values are not written, so they do not count).
    if (!Object.entries(entity).some(([key, value]) => key !== primaryKey && value !== undefined)) {
      return;
    }
    const command = buildUpdateSql(tableName, entity, primaryKey, dialect);
    await this.run(command.sql, command.params);
  }

  /**
   * Deletes a single row identified by the entity's primary key.
   *
   * Generates `` DELETE FROM `tableName` WHERE `pk` = ? ``.
   *
   * @param entity - Object whose primary-key property identifies the row to
   *   delete.
   * @param tableName - Target table name.
   * @returns A promise that resolves when the row has been deleted.
   * @throws {Error} On foreign-key constraint violations.
   *
   * @example
   * await provider.remove({ id: 1 }, 'products');
   */
  async remove<T extends object>(entity: T, tableName: string): Promise<void> {
    const command = buildDeleteSql(tableName, entity, await this.getPrimaryKeyColumn(tableName), dialect);
    await this.run(command.sql, command.params);
  }

  /**
   * Deletes multiple rows, each identified by its entity's primary key.
   *
   * @param entities - Array of entities whose primary keys identify the rows
   *   to delete.
   * @param tableName - Target table name.
   * @returns A promise that resolves when all rows have been deleted.
   * @throws {Error} If any individual delete fails.
   *
   * @example
   * await provider.removeRange([{ id: 1 }, { id: 2 }], 'products');
   */
  async removeRange<T extends object>(entities: T[], tableName: string): Promise<void> {
    for (const entity of entities) {
      await this.remove(entity, tableName);
    }
  }

  /**
   * Retrieves a single row by its primary key.
   *
   * Generates `` SELECT * FROM `tableName` WHERE `pk` = ? `` and returns the
   * first result, or `undefined` when no matching row is found.
   *
   * @param entity - Object whose primary-key property supplies the lookup
   *   value.
   * @param tableName - Target table name.
   * @returns The matching row cast to `T`, or `undefined` if not found.
   * @throws {Error} On connection or query errors.
   *
   * @example
   * const product = await provider.find({ id: 42 }, 'products');
   * if (product) console.log(product.name);
   */
  async find<T extends object>(entity: T, tableName: string): Promise<T | undefined> {
    const command = buildFindSql(tableName, entity, await this.getPrimaryKeyColumn(tableName), dialect);
    const rows = await this.executeQuery<T>(command.sql, command.params);
    return rows[0];
  }

  /**
   * Returns all rows from the specified table.
   *
   * Generates `` SELECT * FROM `tableName` ``.  For large tables, use
   * {@link executeQuery} with a filtered {@link QueryObject}.
   *
   * @param tableName - Source table name.
   * @returns An array of all rows cast to `T`.
   * @throws {Error} On connection or query errors.
   *
   * @example
   * const all = await provider.getAll<Product>('products');
   */
  async getAll<T>(tableName: string): Promise<T[]> {
    return this.executeQuery<T>(buildSelectAllSql(tableName, dialect));
  }

  /**
   * No-op for this provider.
   *
   * MySQL statements issued through `mysql2` are auto-committed by default.
   * Transaction support can be layered on top when needed.
   *
   * @returns A resolved promise.
   */
  async saveChanges(): Promise<void> {
    return;
  }

  /**
   * Records a migration entry in the `` `__roma_migrations` `` history table.
   *
   * Creates the table if it does not yet exist, then inserts a row with the
   * migration name and its SQL script.
   *
   * @param migrationName - Unique name for the migration (e.g.
   *   `"20240101_CreateProducts"`).
   * @param migrationScript - The full DDL/DML script applied by this migration.
   * @returns A promise that resolves once the record is persisted.
   * @throws {Error} On duplicate migration name (PRIMARY KEY violation).
   *
   * @example
   * await provider.addMigration('20240101_Init', 'CREATE TABLE products (...)');
   */
  async addMigration(migrationName: string, migrationScript: string): Promise<void> {
    await this.ensureMigrationHistoryTable();
    await this.run(
      'INSERT INTO `__roma_migrations` (`migrationName`, `migrationScript`) VALUES (?, ?)',
      [migrationName, migrationScript]
    );
  }

  /**
   * Removes a migration entry from the `` `__roma_migrations` `` history table.
   *
   * Used during a downgrade operation to erase the record of an applied
   * migration.
   *
   * @param migrationName - The name of the migration to remove.
   * @returns A promise that resolves once the record has been deleted.
   *
   * @example
   * await provider.removeMigration('20240101_Init');
   */
  async removeMigration(migrationName: string): Promise<void> {
    await this.ensureMigrationHistoryTable();
    await this.run('DELETE FROM `__roma_migrations` WHERE `migrationName` = ?', [migrationName]);
  }

  /**
   * No-op for this provider — migrations are applied individually via the CLI.
   * @returns A resolved promise.
   */
  async applyMigrations(): Promise<void> {
    return;
  }

  /**
   * Returns the list of migration names recorded in the history table.
   *
   * Delegates to {@link getMigrationHistory}.
   *
   * @returns An array of migration name strings in ascending alphabetical order.
   *
   * @example
   * const applied = await provider.getMigrations();
   */
  async getMigrations(): Promise<string[]> {
    return this.getMigrationHistory();
  }

  /**
   * Queries `` `__roma_migrations` `` for all previously applied migration
   * names.
   *
   * Creates the history table first if it does not exist, making this safe to
   * call on a fresh database.
   *
   * @returns An array of migration name strings ordered alphabetically.
   * @throws {Error} On connection or query errors.
   *
   * @example
   * const history = await provider.getMigrationHistory();
   */
  async getMigrationHistory(): Promise<string[]> {
    await this.ensureMigrationHistoryTable();
    const rows = await this.executeQuery<{ migrationName: string }>(
      'SELECT `migrationName` FROM `__roma_migrations` ORDER BY `migrationName`'
    );
    return rows.map(row => row.migrationName);
  }

  /**
   * No-op for this provider — handled by the CLI.
   * @returns A resolved promise.
   */
  async updateDatabase(_targetMigration?: string): Promise<void> {
    return;
  }

  /**
   * No-op for this provider — handled by the CLI.
   * @returns A resolved promise.
   */
  async downgradeDatabase(_targetMigration?: string): Promise<void> {
    return;
  }

  /**
   * Creates a table in MySQL / MariaDB if it does not already exist.
   *
   * Uses `CREATE TABLE IF NOT EXISTS` which is natively supported by MySQL,
   * making the operation idempotent without requiring a separate existence
   * check.
   *
   * @param input.tableName - Name of the table to create.
   * @param input.columns - Column definitions; each column's `tsType` is
   *   mapped to a MySQL type via {@link mapColumnType}.
   * @param input.primaryKey - Optional explicit primary-key column name.
   *   Falls back to the first column with `primaryKey: true`.
   * @returns A promise that resolves once the table exists.
   * @throws {Error} On SQL syntax or permission errors.
   *
   * @example
   * await provider.createTable({
   *   tableName: 'products',
   *   columns: [
   *     { name: 'id', tsType: 'number', primaryKey: true },
   *     { name: 'name', tsType: 'string' }
   *   ]
   * });
   */
  async createTable(input: { tableName: string; columns: TableColumnInfo[]; primaryKey?: string }): Promise<void> {
    const primaryKey = input.primaryKey || input.columns.find(column => column.primaryKey)?.name;
    const columns = input.columns
      .map(column => `${dialect.quoteIdentifier(column.name)} ${this.mapColumnType(column)}${column.primaryKey ? ' NOT NULL' : ''}`)
      .join(', ');
    const primaryKeySql = primaryKey ? `, PRIMARY KEY (${dialect.quoteIdentifier(primaryKey)})` : '';
    await this.run(`CREATE TABLE IF NOT EXISTS ${dialect.quoteIdentifier(input.tableName)} (${columns}${primaryKeySql})`, []);
    this.clearMetadataCache(input.tableName);
  }

  /**
   * Drops a table from the database if it exists.
   *
   * Uses `DROP TABLE IF EXISTS` which is idempotent and does not raise an
   * error when the table is absent.
   *
   * @param tableName - Name of the table to drop.
   * @returns A promise that resolves once the table has been dropped.
   * @throws {Error} On foreign-key constraint violations.
   *
   * @example
   * await provider.dropTable('products');
   */
  async dropTable(tableName: string): Promise<void> {
    await this.run(`DROP TABLE IF EXISTS ${dialect.quoteIdentifier(tableName)}`, []);
    this.clearMetadataCache(tableName);
  }

  /**
   * Adds a new column to an existing table.
   *
   * Generates `` ALTER TABLE `tableName` ADD COLUMN `columnName` <SQL type> ``.
   *
   * @param tableName - Name of the table to alter.
   * @param column - Column definition including name and TypeScript type.
   * @returns A promise that resolves once the column has been added.
   * @throws {Error} If the column already exists.
   *
   * @example
   * await provider.addColumn('products', { name: 'sku', tsType: 'string' });
   */
  async addColumn(tableName: string, column: TableColumnInfo): Promise<void> {
    await this.run(
      `ALTER TABLE ${dialect.quoteIdentifier(tableName)} ADD COLUMN ${dialect.quoteIdentifier(column.name)} ${this.mapColumnType(column)}`,
      []
    );
    this.clearMetadataCache(tableName);
  }

  /**
   * Removes a column from an existing table.
   *
   * Generates `` ALTER TABLE `tableName` DROP COLUMN `columnName` ``.
   *
   * @param tableName - Name of the table to alter.
   * @param columnName - Name of the column to drop.
   * @returns A promise that resolves once the column has been removed.
   * @throws {Error} If the column is referenced by an index or constraint.
   *
   * @example
   * await provider.removeColumn('products', 'sku');
   */
  async removeColumn(tableName: string, columnName: string): Promise<void> {
    await this.run(
      `ALTER TABLE ${dialect.quoteIdentifier(tableName)} DROP COLUMN ${dialect.quoteIdentifier(columnName)}`,
      []
    );
    this.clearMetadataCache(tableName);
  }

  /**
   * No-op for this provider — scaffold is handled by the CLI command.
   * @returns A resolved promise.
   */
  async scaffold(_connectionString: string): Promise<void> {
    return;
  }

  /**
   * Returns the names of all tables in the current database.
   *
   * Uses `SHOW TABLES` which returns a single-column result set whose column
   * name is dynamic (e.g. `Tables_in_mydb`).  We therefore read the first
   * value of each row with `Object.values(row)[0]`.
   *
   * @returns An array of table name strings.
   * @throws {Error} On connection or query errors.
   *
   * @example
   * const tables = await provider.getTables();
   * console.log(tables); // ['products', 'orders', '__roma_migrations']
   */
  async getTables(): Promise<string[]> {
    // SHOW TABLES returns one column whose name varies by database — grab the first value.
    const rows = await this.executeQuery<Record<string, string>>('SHOW TABLES');
    return rows.map(row => Object.values(row)[0]);
  }

  /**
   * Returns column metadata for a given table, including primary-key detection.
   *
   * Queries `INFORMATION_SCHEMA.COLUMNS` and uses the `COLUMN_KEY = 'PRI'`
   * flag to identify the primary-key column.  Only the database of the current
   * connection (`DATABASE()`) is inspected, so a table with the same name in
   * another database cannot leak its columns or primary key into the result.
   *
   * @param table - Name of the table to inspect.
   * @returns An array of {@link TableColumnInfo} objects.
   * @throws {Error} On connection or query errors.
   *
   * @example
   * const cols = await provider.getColumnsForTable('products');
   * // [{ name: 'id', tsType: 'number', primaryKey: true }, ...]
   */
  async getColumnsForTable(table: string): Promise<TableColumnInfo[]> {
    // DATABASE() is the schema the connection actually uses, whatever form
    // the configuration took (object, URI or a connect() override).
    const rows = await this.executeQuery<{ name: string; type: string; columnKey: string }>(
      `
      SELECT COLUMN_NAME as name, DATA_TYPE as type, COLUMN_KEY as columnKey
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
      `,
      [table]
    );

    return rows.map(column => ({
      name: column.name,
      // MySQL uses 'PRI' in COLUMN_KEY to indicate primary key columns.
      primaryKey: column.columnKey === 'PRI',
      tsType: this.mapDbTypeToTsType(column.type)
    }));
  }

  /**
   * Executes a SQL query or a structured {@link QueryObject} and returns the
   * result rows.
   *
   * **Overload 1 — raw SQL:**
   * ```ts
   * const rows = await provider.executeQuery<Product>(
   *   'SELECT * FROM `products` WHERE `id` = ?',
   *   [42]
   * );
   * ```
   *
   * **Overload 2 — QueryObject:**
   * ```ts
   * const rows = await provider.executeQuery('products', query);
   * ```
   * When a `QueryObject` is supplied the provider pushes serializable `WHERE`
   * and `ORDER BY` clauses to MySQL, then re-applies the JS predicates,
   * ordering, paging and projection on copies of the rows whose driver values
   * are converted to the JS types the entity uses (`BOOLEAN`/`TINYINT(1)` and
   * `BIT(1)` to booleans, `DECIMAL` and `BIGINT` strings to numbers, date
   * strings to `Date`), so `where(x => x.active === true)` keeps the rows
   * MySQL matched. The original rows are returned. A predicate MySQL already
   * applied that compares a date column with a string literal is not re-run.
   *
   * Raw statements other than `SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`
   * clear the primary-key cache (see {@link clearMetadataCache}).
   *
   * @param query - Either a raw SQL string or a table name (for QueryObject).
   * @param params - Parameter array for raw SQL, or a `QueryObject`.
   * @returns A promise resolving to an array of result rows.
   * @throws {Error} On SQL syntax errors or connection failures.
   */
  async executeQuery<T = any>(query: string, params?: any[]): Promise<T[]>;
  async executeQuery<T, TResult = T>(entityName: string, query: QueryObject<T, TResult>): Promise<TResult[]>;
  async executeQuery<T, TResult = T>(
    queryOrEntityName: string,
    paramsOrQuery: any[] | QueryObject<T, TResult> = []
  ): Promise<T[] | TResult[]> {
    if (!Array.isArray(paramsOrQuery)) {
      // QueryObject path: build server-side SQL, then apply remaining
      // client-side predicates (e.g. JS closures that can't be serialized).
      const command = buildSelectSql(queryOrEntityName, paramsOrQuery, dialect);
      const [rows, fields] = await this.run(command.sql, command.params);
      return applyQueryToDriverRows(rows as T[], paramsOrQuery, driverColumns(fields));
    }

    if (!READ_ONLY_STATEMENT.test(queryOrEntityName)) {
      // The statement may change the schema (keys included), or roll back DDL.
      this.clearMetadataCache();
    }

    // mysql2 returns [rows, fields]; we only need the rows array.
    const [rows] = await this.run(queryOrEntityName, paramsOrQuery);
    return rows as T[];
  }

  /**
   * Executes a non-query SQL statement (INSERT / UPDATE / DELETE / DDL).
   *
   * Statements with parameters run as prepared statements (`execute()`) with
   * positional `?` placeholders; see {@link run}.
   *
   * @param sql - Parameterized SQL statement with `?` placeholders.
   * @param params - Positional parameter values.
   * @returns A promise that resolves when the statement completes.
   * @throws {Error} On SQL errors or connection failures.
   *
   * @example
   * await provider.executeNonQuery(
   *   'UPDATE `products` SET `price` = ? WHERE `id` = ?',
   *   [12.50, 1]
   * );
   */
  async executeNonQuery(sql: string, params: any[] = []): Promise<void> {
    if (!READ_ONLY_STATEMENT.test(sql)) {
      // The statement may change the schema (keys included).
      this.clearMetadataCache();
    }
    await this.run(sql, params);
  }

  /**
   * Forgets the cached primary-key metadata (of one table, or of all).
   * The provider already does this after its own DDL and after raw
   * statements that are not `SELECT`/`SHOW`; call it when the schema is
   * changed by another process while this provider is connected.
   */
  clearMetadataCache(tableName?: string): void {
    if (tableName === undefined) {
      this.primaryKeyCache.clear();
    } else {
      this.primaryKeyCache.delete(tableName);
    }
  }

  /**
   * Sends a statement to MySQL. Parameterized statements use the prepared
   * statement protocol (`execute()`); statements without parameters use the
   * text protocol (`query()`), because MySQL rejects statements such as
   * `BEGIN`, `START TRANSACTION` or `ROLLBACK` in the prepared protocol
   * (ER_UNSUPPORTED_PS), which broke `DbContext.beginTransaction()`. Nothing
   * is interpolated in either case.
   */
  private run(sql: string, params: any[]): Promise<[any, any]> {
    return params.length > 0
      ? this.connection.execute(sql, params)
      : this.connection.query(sql);
  }

  /**
   * Creates the `` `__roma_migrations` `` history table if it does not exist.
   *
   * `CREATE TABLE IF NOT EXISTS` makes this operation idempotent.  The schema
   * stores the migration name (PK), the full SQL script (`LONGTEXT`), and an
   * `appliedAt` timestamp defaulting to `CURRENT_TIMESTAMP`.
   */
  private async ensureMigrationHistoryTable(): Promise<void> {
    await this.run(`
      CREATE TABLE IF NOT EXISTS \`__roma_migrations\` (
        \`migrationName\` VARCHAR(255) NOT NULL PRIMARY KEY,
        \`migrationScript\` LONGTEXT NOT NULL,
        \`appliedAt\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `, []);
  }

  /**
   * Resolves the primary-key column name for a given table.
   *
   * Falls back to `'id'` when no primary key is detected (e.g. views).
   * Composite keys are rejected: matching rows by only one of their key
   * columns would update or delete every row sharing that value.
   *
   * The key columns are cached per table (see {@link clearMetadataCache}),
   * so `update`/`remove`/`find` cost one round trip instead of two.
   *
   * @param tableName - Table to inspect.
   * @returns The primary-key column name or `'id'`.
   * @throws {Error} If the table has a composite primary key.
   */
  private async getPrimaryKeyColumn(tableName: string): Promise<string> {
    let cached = this.primaryKeyCache.get(tableName);
    if (!cached) {
      const lookup = this.getColumnsForTable(tableName)
        .then(columns => columns.filter(column => column.primaryKey).map(column => column.name));
      cached = lookup;
      this.primaryKeyCache.set(tableName, lookup);
      // A failed lookup is not cached.
      lookup.catch(() => {
        if (this.primaryKeyCache.get(tableName) === lookup) {
          this.primaryKeyCache.delete(tableName);
        }
      });
    }
    const keys = await cached;
    if (keys.length > 1) {
      throw new Error(`Table '${tableName}' has a composite primary key (${keys.join(', ')}); update/remove/find by entity support a single-column key only.`);
    }
    return keys[0] || 'id';
  }

  /**
   * Maps a {@link TableColumnInfo} TypeScript type to a MySQL column type.
   *
   * | tsType      | Primary key | MySQL type       |
   * |-------------|-------------|------------------|
   * | `number`    | yes         | `INT`            |
   * | `number`    | no          | `DOUBLE`         |
   * | `boolean`   | —           | `BOOLEAN`        |
   * | `Date`      | —           | `DATETIME`       |
   * | `unknown`   | —           | `JSON`           |
   * | *(default)* | —           | `VARCHAR(255)`   |
   *
   * @param column - Column definition.
   * @returns The MySQL column type string.
   */
  private mapColumnType(column: TableColumnInfo): string {
    const type = column.tsType.toLowerCase();
    // INT for primary-key numerics; DOUBLE for non-PK floating-point values.
    if (type.includes('number')) return column.primaryKey ? 'INT' : 'DOUBLE';
    if (type.includes('boolean')) return 'BOOLEAN';
    if (type.includes('date')) return 'DATETIME';
    if (type.includes('unknown')) return 'JSON';
    // Default: fixed-length varchar suitable for most text columns.
    return 'VARCHAR(255)';
  }

  /**
   * Maps a MySQL `DATA_TYPE` string to the corresponding TypeScript type used
   * in scaffolded entity classes.
   *
   * | MySQL type pattern                           | TypeScript type |
   * |----------------------------------------------|-----------------|
   * | `int`, `decimal`, `numeric`, `float`, `double`, `real` | `number` |
   * | `bool`, `bit`                                | `boolean`       |
   * | `date`, `time`, `year` (any variant)         | `Date`          |
   * | `json`                                       | `unknown`       |
   * | *(anything else)*                            | `string`        |
   *
   * @param type - Raw `DATA_TYPE` string from `INFORMATION_SCHEMA.COLUMNS`.
   * @returns A TypeScript type name string.
   */
  private mapDbTypeToTsType(type: string): string {
    const normalized = type.toLowerCase();
    if (/(int|decimal|numeric|float|double|real)/.test(normalized)) return 'number';
    if (/(bool|bit)/.test(normalized)) return 'boolean';
    if (/(date|time|year)/.test(normalized)) return 'Date';
    if (/(json)/.test(normalized)) return 'unknown';
    return 'string';
  }
}

/** mysql2 column type codes (`FieldPacket.columnType`). */
const MYSQL_TYPE = { DECIMAL: 0, TINY: 1, TIMESTAMP: 7, LONGLONG: 8, DATE: 10, DATETIME: 12, NEWDATE: 14, BIT: 16, NEWDECIMAL: 246 };

/**
 * Converters for the columns of a mysql2 result set: `BOOLEAN`/`TINYINT(1)`
 * and `BIT(1)` to booleans, `DECIMAL` (a string by default) and `BIGINT`
 * strings to numbers, date strings (`dateStrings` option) to `Date`.
 */
function driverColumns(fields: any[] | undefined): DriverColumns {
  const converters: Record<string, ValueConverter> = {};
  const temporal = new Set<string>();
  for (const field of fields || []) {
    const type = field?.columnType ?? field?.type;
    if ((type === MYSQL_TYPE.TINY || type === MYSQL_TYPE.BIT) && field.columnLength === 1) {
      converters[field.name] = toBoolean;
    } else if (type === MYSQL_TYPE.DECIMAL || type === MYSQL_TYPE.NEWDECIMAL || type === MYSQL_TYPE.LONGLONG) {
      converters[field.name] = toNumber;
    } else if ([MYSQL_TYPE.DATE, MYSQL_TYPE.NEWDATE, MYSQL_TYPE.DATETIME, MYSQL_TYPE.TIMESTAMP].includes(type)) {
      converters[field.name] = toDate;
      temporal.add(field.name);
    }
  }
  return { converters, temporal };
}
