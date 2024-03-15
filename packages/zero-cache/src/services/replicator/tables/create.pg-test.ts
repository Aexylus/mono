import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from '@jest/globals';
import type postgres from 'postgres';
import {TestDBs} from '../../../test/db.js';
import {createTableStatement} from './create.js';
import {getPublishedTables} from './published.js';
import type {TableSpec} from './specs.js';

describe('tables/create', () => {
  type Case = {
    name: string;
    tableSpec: TableSpec;
  };

  const cases: Case[] = [
    {
      name: 'zero clients',
      tableSpec: {
        schema: 'public',
        name: 'clients',
        columns: {
          ['client_id']: {
            dataType: 'character varying',
            characterMaximumLength: 180,
            columnDefault: null,
          },
          ['last_mutation_id']: {
            dataType: 'bigint',
            characterMaximumLength: null,
            columnDefault: null,
          },
        },
        primaryKey: ['client_id'],
      },
    },
    {
      name: 'types and array types and defaults',
      tableSpec: {
        schema: 'public',
        name: 'users',
        columns: {
          ['user_id']: {
            dataType: 'integer',
            characterMaximumLength: null,
            columnDefault: null,
          },
          handle: {
            characterMaximumLength: 40,
            columnDefault: "'@foo'::text",
            dataType: 'character varying',
          },
          address: {
            characterMaximumLength: null,
            columnDefault: null,
            dataType: 'text[]',
          },
          ['timez']: {
            dataType: 'timestamp with time zone[]',
            characterMaximumLength: null,
            columnDefault: null,
          },
          ['bigint_array']: {
            characterMaximumLength: null,
            columnDefault: null,
            dataType: 'bigint[]',
          },
          ['bool_array']: {
            characterMaximumLength: null,
            columnDefault: null,
            dataType: 'boolean[]',
          },
          ['real_array']: {
            characterMaximumLength: null,
            columnDefault: null,
            dataType: 'real[]',
          },
          ['int_array']: {
            dataType: 'integer[]',
            characterMaximumLength: null,
            columnDefault: "'{1,2,3}'::integer[]",
          },
          ['json_val']: {
            dataType: 'jsonb',
            characterMaximumLength: null,
            columnDefault: null,
          },
        },
        primaryKey: ['user_id'],
      },
    },
  ];

  const testDBs = new TestDBs();
  let db: postgres.Sql;
  beforeEach(async () => {
    db = await testDBs.create('create_tables_test');
    await db`CREATE PUBLICATION zero_all FOR ALL TABLES`;
  });

  afterEach(async () => {
    await testDBs.drop(db);
  });

  afterAll(async () => {
    await testDBs.end();
  });

  for (const c of cases) {
    test(c.name, async () => {
      await db.unsafe(createTableStatement(c.tableSpec));

      const tables = await getPublishedTables(db, 'zero_');
      expect(tables[`${c.tableSpec.schema}.${c.tableSpec.name}`]).toEqual(
        c.tableSpec,
      );
    });
  }
});
