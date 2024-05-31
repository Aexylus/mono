import type {LogContext} from '@rocicorp/logger';
import {createSilentLogContext} from 'shared/src/logging-test-utils.js';
import {randInt} from 'shared/src/rand.js';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {
  Mode,
  TransactionPool,
  synchronizedSnapshots,
} from '../../db/transaction-pool.js';
import {expectTables, initDB, testDBs} from '../../test/db.js';
import {
  NormalizedInvalidationFilterSpec,
  invalidationHash,
  normalizeFilterSpec,
} from '../../types/invalidation.js';
import type {PostgresDB} from '../../types/pg.js';
import {
  InvalidationFilters,
  InvalidationProcessor,
  Invalidator,
} from './invalidation.js';
import type {RegisterInvalidationFiltersResponse} from './replicator.js';
import {CREATE_INVALIDATION_TABLES} from './schema/invalidation.js';
import {CREATE_REPLICATION_TABLES} from './schema/replication.js';
import {TransactionTrainService} from './transaction-train.js';
import {TableTracker, type RowChange} from './types/table-tracker.js';

describe('replicator/invalidation', () => {
  let db: PostgresDB;

  const FOO_SPEC1 = normalizeFilterSpec({
    schema: 'public',
    table: 'foo',
    filteredColumns: {id: '='},
  });

  const FOO_SPEC2 = normalizeFilterSpec({
    schema: 'public',
    table: 'foo',
    filteredColumns: {id: '=', name: '='},
    selectedColumns: ['id', 'name'],
  });

  const BAR_SPEC1 = normalizeFilterSpec({
    schema: 'public',
    table: 'bar',
    filteredColumns: {id: '='},
  });

  const BAR_SPEC2 = normalizeFilterSpec({
    schema: 'public',
    table: 'bar',
    filteredColumns: {},
    selectedColumns: ['id', 'name'],
  });

  const DATE1 = new Date(Date.UTC(2024, 2, 27, 1, 2, 3));
  const DATE2 = new Date(Date.UTC(2024, 2, 1, 2, 3, 4));
  const NOW = new Date(Date.UTC(2024, 4, 1, 2, 3, 4));

  describe('registration', () => {
    let train: TransactionTrainService;
    let lc: LogContext;
    let invalidator: Invalidator;

    beforeEach(async () => {
      db = await testDBs.create('invalidation_test');
      await db.unsafe(
        `CREATE SCHEMA _zero;` +
          CREATE_INVALIDATION_TABLES +
          CREATE_REPLICATION_TABLES,
      );
      lc = createSilentLogContext();
      train = new TransactionTrainService(lc, db);
      invalidator = new Invalidator(db, train, new InvalidationFilters());
    });

    afterEach(async () => {
      await train.stop();
      await testDBs.drop(db);
    });

    type RegistrationTestCase = {
      name: string;
      specs: NormalizedInvalidationFilterSpec[];
      response: RegisterInvalidationFiltersResponse;
      setup?: Record<string, Record<string, unknown>[]>;
      setupStmts?: string;
      expected?: Record<string, Record<string, unknown>[]>;
    };

    const regCases: RegistrationTestCase[] = [
      {
        name: 'empty registry, no transactions',
        specs: [FOO_SPEC1, FOO_SPEC2],
        response: {
          specs: [
            {
              id: FOO_SPEC1.id,
              fromStateVersion: '00',
            },
            {
              id: FOO_SPEC2.id,
              fromStateVersion: '00',
            },
          ],
        },
        expected: {
          ['_zero.InvalidationRegistryVersion']: [
            {stateVersionAtLastSpecChange: '00', lock: 'v'},
          ],
          ['_zero.InvalidationRegistry']: [
            {
              id: FOO_SPEC1.id,
              spec: FOO_SPEC1,
              fromStateVersion: '00',
              lastRequested: NOW,
            },
            {
              id: FOO_SPEC2.id,
              spec: FOO_SPEC2,
              fromStateVersion: '00',
              lastRequested: NOW,
            },
          ],
        },
      },
      {
        name: 'already registered',
        setup: {
          ['_zero.InvalidationRegistry']: [
            {
              id: FOO_SPEC1.id,
              spec: FOO_SPEC1,
              fromStateVersion: '03',
              lastRequested: DATE1,
            },
            {
              id: FOO_SPEC2.id,
              spec: FOO_SPEC2,
              fromStateVersion: '02',
              lastRequested: DATE2,
            },
          ],
        },
        specs: [FOO_SPEC1, FOO_SPEC2],
        response: {
          specs: [
            {
              id: FOO_SPEC2.id,
              fromStateVersion: '02',
            },
            {
              id: FOO_SPEC1.id,
              fromStateVersion: '03',
            },
          ],
        },
      },
      {
        name: 'partially registered, existing changes',
        setup: {
          ['_zero.TxLog']: [
            {stateVersion: '04', lsn: '0/023', time: DATE2, xid: 123},
          ],
          ['_zero.InvalidationRegistry']: [
            {
              id: FOO_SPEC2.id,
              spec: FOO_SPEC2,
              fromStateVersion: '02',
              lastRequested: DATE1,
            },
          ],
        },
        setupStmts: `UPDATE _zero."InvalidationRegistryVersion" SET "stateVersionAtLastSpecChange" = '02'`,
        specs: [FOO_SPEC1, FOO_SPEC2],
        response: {
          specs: [
            {
              id: FOO_SPEC2.id,
              fromStateVersion: '02',
            },
            {
              id: FOO_SPEC1.id,
              fromStateVersion: '04',
            },
          ],
        },
        expected: {
          ['_zero.InvalidationRegistryVersion']: [
            {stateVersionAtLastSpecChange: '04', lock: 'v'},
          ],
          ['_zero.InvalidationRegistry']: [
            {
              id: FOO_SPEC2.id,
              spec: FOO_SPEC2,
              fromStateVersion: '02',
              lastRequested: DATE1,
            },
            {
              id: FOO_SPEC1.id,
              spec: FOO_SPEC1,
              fromStateVersion: '04',
              lastRequested: NOW,
            },
          ],
        },
      },
    ];

    for (const c of regCases) {
      test(c.name, async () => {
        await initDB(db, c.setupStmts, c.setup);

        void train.run();
        const resp = await invalidator.registerInvalidationFilters(
          lc,
          {specs: c.specs},
          NOW,
        );

        expect(resp).toEqual(c.response);
        await expectTables(db, c.expected);
      });
    }
  });

  describe('invalidation-processor', () => {
    let lc: LogContext;
    let train: TransactionTrainService;

    beforeEach(async () => {
      db = await testDBs.create('invalidation_test');
      await db.unsafe(
        `CREATE SCHEMA _zero;` +
          CREATE_INVALIDATION_TABLES +
          CREATE_REPLICATION_TABLES +
          `
      CREATE TABLE foo (id int PRIMARY KEY, name text);
      INSERT INTO foo (id, name) VALUES (1, 'one');
      INSERT INTO foo (id, name) VALUES (2, 'two');
      INSERT INTO foo (id, name) VALUES (3, 'three');

      CREATE TABLE bar (id text PRIMARY KEY, name text);
      INSERT INTO bar (id, name) VALUES ('one', 'fun');
      INSERT INTO bar (id, name) VALUES ('two', 'true');
      INSERT INTO bar (id, name) VALUES ('three', 'whee');
        `,
      );

      lc = createSilentLogContext();
      train = new TransactionTrainService(lc, db);
      void train.run();
      const invalidator = new Invalidator(db, train, new InvalidationFilters());
      await invalidator.registerInvalidationFilters(
        lc,
        {specs: [FOO_SPEC1, FOO_SPEC2, BAR_SPEC1, BAR_SPEC2]},
        NOW,
      );
    });

    afterEach(async () => {
      await train.stop();
      await testDBs.drop(db);
    });

    type InvalidationCase = {
      name: string;
      fooChanges?: (RowChange | 'truncate')[];
      barChanges?: (RowChange | 'truncate')[];
      expectedHashes: string[];
    };

    const invalidationCases: InvalidationCase[] = [
      {
        name: 'no changes',
        expectedHashes: [],
      },
      {
        name: 'insert',
        fooChanges: [
          {
            preValue: 'none',
            postRowKey: {id: 4},
            postValue: {id: 4, name: 'for'},
          },
        ],
        expectedHashes: [
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '4'},
          }),
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '4', name: '"for"'},
            selectedColumns: ['id', 'name'],
          }),
        ],
      },
      {
        name: 'update',
        fooChanges: [
          {
            preValue: 'unknown',
            postRowKey: {id: 3},
            postValue: {id: 3, name: 'free'},
          },
        ],
        expectedHashes: [
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '3'},
          }),
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '3', name: '"three"'},
            selectedColumns: ['id', 'name'],
          }),
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '3', name: '"free"'},
            selectedColumns: ['id', 'name'],
          }),
        ],
      },
      {
        name: 'delete',
        fooChanges: [
          {
            preValue: 'unknown',
            postRowKey: {id: 1},
            postValue: 'none',
          },
        ],
        expectedHashes: [
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '1'},
          }),
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '1', name: '"one"'},
            selectedColumns: ['id', 'name'],
          }),
        ],
      },
      {
        name: 'update with row key change',
        fooChanges: [
          {
            preValue: 'unknown',
            preRowKey: {id: 3},
            postRowKey: {id: 4},
            postValue: {id: 4, name: 'more'},
          },
        ],
        expectedHashes: [
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '3'},
          }),
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '4'},
          }),
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '3', name: '"three"'},
            selectedColumns: ['id', 'name'],
          }),
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '4', name: '"more"'},
            selectedColumns: ['id', 'name'],
          }),
        ],
      },
      {
        name: 'multiple changes',
        fooChanges: [
          {
            // insert
            preValue: 'none',
            postRowKey: {id: 4},
            postValue: {id: 4, name: 'more'},
          },
          {
            // update
            preValue: 'unknown',
            preRowKey: {id: 4},
            postRowKey: {id: 5},
            postValue: {id: 5, name: 'live'},
          },
          {
            // delete
            preValue: 'unknown',
            postRowKey: {id: 3},
            postValue: 'none',
          },
        ],
        barChanges: [
          {
            // update
            preValue: 'unknown',
            postRowKey: {id: 'two'},
            postValue: {id: 'two', name: 'blue'},
          },
          {
            // delete
            preValue: 'unknown',
            postRowKey: {id: 'three'},
            postValue: 'none',
          },
        ],
        expectedHashes: [
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '3'},
          }),
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '5'},
          }),
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '3', name: '"three"'},
            selectedColumns: ['id', 'name'],
          }),
          invalidationHash({
            schema: 'public',
            table: 'foo',
            filteredColumns: {id: '5', name: '"live"'},
            selectedColumns: ['id', 'name'],
          }),
          invalidationHash({
            schema: 'public',
            table: 'bar',
            filteredColumns: {id: '"two"'},
          }),
          invalidationHash({
            schema: 'public',
            table: 'bar',
            filteredColumns: {id: '"three"'},
          }),
          invalidationHash({
            schema: 'public',
            table: 'bar',
            filteredColumns: {},
            selectedColumns: ['id', 'name'],
          }),
        ],
      },
      {
        name: 'multiple changes with truncate',
        fooChanges: [
          'truncate',
          // The rest of the changes need not produce an invalidation tag.
          {
            // insert
            preValue: 'none',
            postRowKey: {id: 4},
            postValue: {id: 4, name: 'more'},
          },
          {
            // update
            preValue: 'unknown',
            preRowKey: {id: 4},
            postRowKey: {id: 5},
            postValue: {id: 5, name: 'live'},
          },
          {
            // delete
            preValue: 'unknown',
            postRowKey: {id: 3},
            postValue: 'none',
          },
        ],
        barChanges: [
          {
            // update
            preValue: 'unknown',
            postRowKey: {id: 'two'},
            postValue: {id: 'two', name: 'blue'},
          },
          {
            // delete
            preValue: 'unknown',
            postRowKey: {id: 'three'},
            postValue: 'none',
          },
        ],
        expectedHashes: [
          invalidationHash({
            schema: 'public',
            table: 'foo',
            allRows: true,
          }),
          invalidationHash({
            schema: 'public',
            table: 'bar',
            filteredColumns: {id: '"two"'},
          }),
          invalidationHash({
            schema: 'public',
            table: 'bar',
            filteredColumns: {id: '"three"'},
          }),
          invalidationHash({
            schema: 'public',
            table: 'bar',
            filteredColumns: {},
            selectedColumns: ['id', 'name'],
          }),
        ],
      },
    ];

    const OLD_VERSION = '02';
    const NEW_VERSION = '0d';

    for (const c of invalidationCases) {
      test(c.name, async () => {
        // Randomly write some of the hashes to an old version (to verify UPSERT).
        for (const hash of c.expectedHashes) {
          if (randInt(0, 1)) {
            await db`
            INSERT INTO _zero."InvalidationIndex" ${db({
              hash: Buffer.from(hash, 'hex'),
              stateVersion: OLD_VERSION,
            })}
            `;
          }
        }

        const {exportSnapshot, cleanupExport, setSnapshot} =
          synchronizedSnapshots();
        const writer = new TransactionPool(
          lc.withContext('pool', 'writer'),
          Mode.SERIALIZABLE,
          exportSnapshot,
          cleanupExport,
        );
        const readers = new TransactionPool(
          lc.withContext('pool', 'readers'),
          Mode.READONLY,
          setSnapshot,
          undefined,
          1, // start with 1 worker
          2, // but allow growing the pool to 2 workers
        );
        void writer.run(db);
        void readers.run(db);

        const processor = new InvalidationProcessor(new InvalidationFilters());
        processor.processInitTasks(readers, null);

        const fooTable = new TableTracker('public', 'foo', {id: {typeOid: 23}});
        const barTable = new TableTracker('public', 'bar', {id: {typeOid: 25}});

        for (const change of c.fooChanges ?? []) {
          if (change === 'truncate') {
            fooTable.truncate();
          } else {
            fooTable.add(change);
          }
        }
        for (const change of c.barChanges ?? []) {
          if (change === 'truncate') {
            barTable.truncate();
          } else {
            barTable.add(change);
          }
        }
        processor.processFinalTasks(readers, writer, NEW_VERSION, [
          fooTable,
          barTable,
        ]);

        // Let the readers finish first so that it can capture the exported
        // snapshot. If the writer is otherwise set done too early, the reader
        // will not be able to set its snapshot and Postgres will throw.
        readers.setDone();
        await readers.done();
        writer.setDone();
        await writer.done();

        const index =
          await db`SELECT hash, "stateVersion" FROM _zero."InvalidationIndex"`;
        const hashes = index.map(row => (row.hash as Buffer).toString('hex'));
        expect(hashes).toEqual(expect.arrayContaining(c.expectedHashes));
        index.forEach(row => expect(row.stateVersion).toBe(NEW_VERSION));
      });
    }
  });
});
