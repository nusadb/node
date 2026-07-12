// Type-level test for index.d.ts — it is type-checked, never executed. Run `tsc --noEmit` (with
// the TypeScript compiler available) to verify the declarations compile and infer as intended.
// Each `const x: Expected = ...` line asserts the inferred type; a regression fails compilation.

import { Orm, Migrator } from './index';
import type { Migration, MigrationStatus, SchemaDiff, MigrationPlan, SyncResult } from './index';

interface User {
  id: number;
  name: string;
  active: boolean;
}

async function main(): Promise<void> {
  const orm: Orm = await Orm.connect({ host: '127.0.0.1', port: 5678, user: 'u', database: 'nusadb' });

  const User = orm.model<User>('app_user', {
    id: { type: 'int', primaryKey: true },
    name: { type: 'text', notNull: true },
    active: 'bool',
  });

  // select(): typed reads.
  const all: User[] = await User.select().orderBy('id').all();
  const one: User | null = await User.select().where({ id: 1 }).first();
  const some: User[] = await User.select().where({ name: { like: 'a%' }, id: { in: [1, 2] } }).all();
  const total: number = await User.select().where({ active: true }).count();
  void all;
  void one;
  void some;
  void total;

  // pagination, distinct, projection, joins, and aggregate terminals.
  const page: User[] = await User.select().orderBy('id').limit(10).offset(20).all();
  const distinctNames: User[] = await User.select().distinct().columns('name').all();
  const joined: User[] = await User.select()
    .columns('id', 'name')
    .join('app_order', '"app_user"."id" = "app_order"."user_id"')
    .leftJoin('app_profile', '"app_user"."id" = "app_profile"."user_id"')
    .all();
  const sum: number | null = await User.select().sum('id');
  const avg: number | null = await User.select().where({ active: true }).avg('id');
  const min: unknown = await User.select().min('name');
  const max: unknown = await User.select().max('id');

  // operators, logical groups, GROUP BY/HAVING, and set operations.
  const ops: User[] = await User.select()
    .where({ id: { notIn: [1, 2], between: [1, 100] }, name: { ilike: 'a%' } })
    .all();
  const logical: User[] = await User.select()
    .where({ $or: [{ id: 1 }, { active: false }], $and: [{ name: { like: 'a%' } }] })
    .all();
  const grouped: User[] = await User.select()
    .selectRaw('active', 'count(*) AS n')
    .groupBy('active')
    .having('count(*) >= ?', [2])
    .all();
  const combined: User[] = await User.select()
    .columns('id')
    .union(User.select().columns('id'))
    .except(User.select().columns('id'))
    .all();
  void page;
  void distinctNames;
  void joined;
  void sum;
  void avg;
  void min;
  void max;
  void ops;
  void logical;
  void grouped;
  void combined;

  // writes: insert resolves to the row or null; update/delete to arrays.
  const created: User | null = await User.insert({ id: 1, name: 'alice', active: true });
  const updated: User[] = await User.update({ active: false }).where({ id: 1 });
  const deleted: User[] = await User.delete().where({ id: 1 });
  void created;
  void updated;
  void deleted;

  // DDL.
  await User.createTable({ ifNotExists: true });
  await User.dropTable({ ifExists: true });

  // schema auto-diff.
  const sql: string = User.createTableSql({ ifNotExists: true });
  const diff: SchemaDiff = await User.diffSchema();
  const plan: MigrationPlan = await User.migrationPlan();
  const synced: SyncResult = await User.syncSchema();
  const exists: boolean = diff.exists;
  const stmts: string[] = plan.statements;
  const syncedApplied: string[] = synced.applied;
  void sql;
  void exists;
  void stmts;
  void syncedApplied;

  // relations (chainable, returns the model).
  const Order = orm.model('app_order');
  User.hasMany('orders', Order, { foreignKey: 'user_id' }).hasOne('profile', Order, { foreignKey: 'user_id' });
  Order.belongsTo('user', User, { foreignKey: 'user_id' });
  const eager: User[] = await User.select().include('orders', 'profile').all();
  const bob: User | null = await User.select().where({ id: 2 }).first();
  if (bob) {
    const loaded: User = await User.loadRelated(bob, 'orders');
    void loaded;
  }
  void eager;

  // transaction returns the callback's value.
  const txValue: number = await orm.transaction(async (tx) => {
    await tx.raw('SELECT 1');
    return 42;
  });
  void txValue;

  // migrations.
  const migrations: Migration[] = [
    {
      version: '0001_init',
      async up(m) {
        await m.raw('CREATE TABLE t (id INT NOT NULL, PRIMARY KEY (id))');
      },
      async down(m) {
        await m.raw('DROP TABLE t');
      },
    },
  ];
  const migrator = new Migrator(orm, migrations, { table: 'schema_migrations' });
  const applied: string[] = await migrator.migrate();
  const rolledBack: string[] = await migrator.rollback(1);
  const status: MigrationStatus[] = await migrator.status();
  void applied;
  void rolledBack;
  void status;

  await orm.close();
}

void main;
