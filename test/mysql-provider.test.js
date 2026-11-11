'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { QueryBuilder } = require('@romatech/orm');
const { MySqlProvider } = require('../dist');

/**
 * Provider whose mysql2 connection is replaced by a stub recording protocol
 * and SQL. `result` ({ rows, fields }) answers `SELECT * FROM` statements.
 */
function stubProvider(columns, result = { rows: [], fields: [] }) {
  const statements = [];
  const provider = new MySqlProvider('mysql://unused');
  const respond = sql => /INFORMATION_SCHEMA\.COLUMNS/.test(sql)
    ? [columns, []]
    : /^SELECT \* FROM/.test(sql) ? [result.rows.map(row => ({ ...row })), result.fields] : [[], []];
  provider.connection = {
    async execute(sql, params) { statements.push({ via: 'execute', sql, params }); return respond(sql); },
    async query(sql) { statements.push({ via: 'query', sql }); return respond(sql); }
  };
  return { provider, statements };
}

const singleKey = [
  { name: 'id', type: 'int', columnKey: 'PRI' },
  { name: 'name', type: 'varchar', columnKey: '' }
];
const compositeKey = [
  { name: 'orderId', type: 'int', columnKey: 'PRI' },
  { name: 'lineNo', type: 'int', columnKey: 'PRI' }
];

test('statements without parameters use the text protocol (BEGIN is not preparable)', async () => {
  const { provider, statements } = stubProvider(singleKey);
  await provider.executeQuery('BEGIN', []);
  await provider.executeQuery('SELECT * FROM `items` WHERE `id` = ?', [1]);
  assert.deepEqual(statements.map(s => s.via), ['query', 'execute']);
});

test('column introspection is limited to the connection database', async () => {
  const { provider, statements } = stubProvider(singleKey);
  await provider.getColumnsForTable('items');
  assert.match(statements[0].sql, /TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME = \?/);
  assert.deepEqual(statements[0].params, ['items']);
});

describe('primary key handling', () => {
  for (const method of ['update', 'remove', 'find']) {
    test(`${method}() refuses a composite primary key`, async () => {
      const { provider, statements } = stubProvider(compositeKey);
      await assert.rejects(() => provider[method]({ orderId: 1, lineNo: 1 }, 'lines'), /composite primary key/);
      assert.ok(statements.every(s => /INFORMATION_SCHEMA/.test(s.sql)), 'no DML must be sent');
    });
  }

  test('update() with only undefined values besides the key sends nothing', async () => {
    const { provider, statements } = stubProvider(singleKey);
    await provider.update({ id: 1, name: undefined }, 'items');
    assert.ok(statements.every(s => !s.sql.startsWith('UPDATE')));
  });
});

describe('primary key cache', () => {
  const introspections = statements => statements.filter(s => /INFORMATION_SCHEMA\.COLUMNS/.test(s.sql)).length;

  test('the primary key is introspected once per table, not on every operation', async () => {
    const { provider, statements } = stubProvider(singleKey);
    await provider.update({ id: 1, name: 'a' }, 'items');
    await provider.remove({ id: 1 }, 'items');
    await provider.find({ id: 1 }, 'items');
    assert.equal(introspections(statements), 1);
  });

  test('DDL and raw non-SELECT statements invalidate the cached key; SELECT does not', async () => {
    const { provider, statements } = stubProvider(singleKey);
    await provider.remove({ id: 1 }, 'items');
    await provider.executeQuery('SELECT 1', []);
    await provider.remove({ id: 1 }, 'items');
    assert.equal(introspections(statements), 1);
    await provider.addColumn('items', { name: 'x', tsType: 'string' });
    await provider.remove({ id: 1 }, 'items');
    assert.equal(introspections(statements), 2);
    await provider.executeNonQuery('ALTER TABLE `items` DROP PRIMARY KEY');
    await provider.remove({ id: 1 }, 'items');
    assert.equal(introspections(statements), 3);
    provider.clearMetadataCache('items');
    await provider.remove({ id: 1 }, 'items');
    assert.equal(introspections(statements), 4);
  });

  test('a failed key lookup is not cached', async () => {
    const { provider, statements } = stubProvider(singleKey);
    const execute = provider.connection.execute;
    let fail = true;
    provider.connection.execute = async (sql, params) => {
      if (fail && /INFORMATION_SCHEMA/.test(sql)) { fail = false; throw new Error('lookup failed'); }
      return execute(sql, params);
    };
    await assert.rejects(() => provider.remove({ id: 1 }, 'items'), /lookup failed/);
    await provider.remove({ id: 1 }, 'items');
    assert.ok(statements.some(s => s.sql.startsWith('DELETE')));
  });
});

describe('client-side predicates on driver values', () => {
  // mysql2 column type codes: TINY 1, BIT 16, NEWDECIMAL 246, LONGLONG 8, DATETIME 12
  const fields = [
    { name: 'id', columnType: 8, columnLength: 20 },
    { name: 'active', columnType: 1, columnLength: 1 },
    { name: 'flag', columnType: 16, columnLength: 1 },
    { name: 'price', columnType: 246, columnLength: 12 },
    { name: 'born', columnType: 12, columnLength: 19 },
    { name: 'small', columnType: 1, columnLength: 4 }
  ];
  const rows = [
    { id: 1, active: 1, flag: Buffer.from([1]), price: '12.50', born: new Date(2024, 0, 2, 3, 4, 5), small: 1 },
    { id: 2, active: 0, flag: Buffer.from([0]), price: '9.99', born: new Date(2023, 5, 1), small: 0 }
  ];
  const query = provider => new QueryBuilder(class Item {}, provider, 'items');

  test('BOOLEAN (TINYINT(1)) and BIT(1) columns match boolean predicates', async () => {
    const { provider } = stubProvider(singleKey, { rows, fields });
    assert.deepEqual((await query(provider).where(x => x.active === true).toList()).map(r => r.id), [1]);
    assert.deepEqual((await query(provider).where(x => x.flag === false).toList()).map(r => r.id), [2]);
    // A wider TINYINT stays a number.
    assert.deepEqual((await query(provider).where(x => x.small === 1).toList()).map(r => r.id), [1]);
  });

  test('predicates written against the driver values (2.0.0 style) still match the rows MySQL returned', async () => {
    // MySQL applied `active = 1` / `small = 1` / `price = '12.50'`; the re-check must not drop the rows.
    const { provider } = stubProvider(singleKey, { rows: [rows[0]], fields });
    assert.deepEqual((await query(provider).where(x => x.active === 1).toList()).map(r => r.id), [1]);
    assert.deepEqual((await query(provider).where(x => x.price === '12.50').toList()).map(r => r.id), [1]);
    // When JavaScript is the only filter (untranslatable predicate), the converted value decides.
    const { provider: all } = stubProvider(singleKey, { rows, fields });
    const ids = [1, 2];
    assert.deepEqual((await query(all).where(x => ids.includes(x.id) && x.active !== true).toList()).map(r => r.id), [2]);
  });

  test('DECIMAL strings compare and sort as numbers; the driver rows are returned', async () => {
    const { provider } = stubProvider(singleKey, { rows, fields });
    const matched = await query(provider).where(x => x.price === 12.5).toList();
    assert.deepEqual(matched.map(r => r.price), ['12.50']);
    const sorted = await query(provider).orderByDescending(x => x.price).toList();
    assert.deepEqual(sorted.map(r => r.id), [1, 2]);
  });

  test('a DATETIME compared with a string literal is left to MySQL', async () => {
    const { provider, statements } = stubProvider(singleKey, { rows: [rows[0]], fields });
    const matched = await query(provider).where(x => x.born >= '2024-01-01').toList();
    assert.match(statements.at(-1).sql, /WHERE `born` >= \?/);
    assert.deepEqual(matched.map(r => r.id), [1]);
  });

  test('date strings (dateStrings option) are compared as dates by closures', async () => {
    const asStrings = rows.map(row => ({ ...row, born: row.id === 1 ? '2024-01-02 03:04:05' : '2023-06-01 00:00:00' }));
    const { provider } = stubProvider(singleKey, { rows: asStrings, fields });
    const since = new Date(2024, 0, 1);
    const matched = await query(provider).where(x => x.born > since).toList();
    assert.deepEqual(matched.map(r => r.born), ['2024-01-02 03:04:05']);
  });
});

// ─── Integration (MYSQL_TEST_URL=mysql://user:pass@host:port/db) ──────────────

const url = process.env.MYSQL_TEST_URL;

describe('integration with a real MySQL', { skip: !url && 'set MYSQL_TEST_URL to run' }, () => {
  test('transactions, composite keys and database isolation', async () => {
    const provider = new MySqlProvider(url);
    await provider.connect('');
    const other = `roma_other_${process.pid}`;
    try {
      await provider.executeQuery('DROP TABLE IF EXISTS `roma_lines`, `roma_items`', []);
      await provider.executeQuery(`CREATE DATABASE IF NOT EXISTS \`${other}\``, []);
      await provider.executeQuery('CREATE TABLE `roma_lines` (`orderId` int, `lineNo` int, PRIMARY KEY (`orderId`, `lineNo`))', []);
      await provider.executeQuery('CREATE TABLE `roma_items` (`id` int PRIMARY KEY, `name` varchar(20))', []);
      await provider.executeQuery(`CREATE TABLE \`${other}\`.\`roma_items\` (\`code\` varchar(20) PRIMARY KEY, \`extra\` text)`, []);

      const columns = await provider.getColumnsForTable('roma_items');
      assert.deepEqual(columns.map(c => [c.name, c.primaryKey]), [['id', true], ['name', false]]);

      await provider.addRange([{ orderId: 1, lineNo: 1 }, { orderId: 1, lineNo: 2 }], 'roma_lines');
      await assert.rejects(() => provider.remove({ orderId: 1, lineNo: 1 }, 'roma_lines'), /composite primary key/);
      assert.equal((await provider.getAll('roma_lines')).length, 2);

      await provider.add({ id: 1, name: 'a' }, 'roma_items');
      await provider.executeQuery('BEGIN', []);
      await provider.update({ id: 1, name: 'b' }, 'roma_items');
      await provider.executeQuery('ROLLBACK', []);
      assert.equal((await provider.find({ id: 1 }, 'roma_items')).name, 'a');

      await provider.executeQuery('CREATE TABLE `roma_flags` (`id` bigint PRIMARY KEY, `active` BOOLEAN, `price` DECIMAL(10,2), `born` DATETIME)', []);
      await provider.addRange([
        { id: 1, active: true, price: 12.5, born: new Date(2024, 0, 2) },
        { id: 2, active: false, price: 9.99, born: new Date(2023, 5, 1) }
      ], 'roma_flags');
      const q = () => new QueryBuilder(class Flag {}, provider, 'roma_flags');
      assert.deepEqual((await q().where(x => x.active === true).toList()).map(r => r.id), [1]);
      assert.deepEqual((await q().where(x => x.price === 12.5).toList()).map(r => r.id), [1]);
      assert.deepEqual((await q().where(x => x.born >= '2024-01-01').toList()).map(r => r.id), [1]);
    } finally {
      await provider.executeQuery('DROP TABLE IF EXISTS `roma_flags`', []);
      await provider.executeQuery('DROP TABLE IF EXISTS `roma_lines`, `roma_items`', []);
      await provider.executeQuery(`DROP DATABASE IF EXISTS \`${other}\``, []);
      await provider.disconnect();
    }
  });
});
