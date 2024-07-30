import {assert} from 'shared/src/asserts.js';
import {createSilentLogContext} from 'shared/src/logging-test-utils.js';
import {Queue} from 'shared/src/queue.js';
import {sleep} from 'shared/src/sleep.js';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import type {Downstream, PokePartBody} from 'zero-protocol';
import type {AST} from 'zql/src/zql/ast/ast.js';
import {Mode, TransactionPool} from '../../db/transaction-pool.js';
import {expectTables, testDBs} from '../../test/db.js';
import type {PostgresDB} from '../../types/pg.js';
import type {CancelableAsyncIterable} from '../../types/streams.js';
import {Subscription} from '../../types/subscription.js';
import type {
  InvalidationWatcher,
  QueryInvalidationUpdate,
  WatchRequest,
} from '../invalidation-watcher/invalidation-watcher.js';
import type {InvalidationWatcherRegistry} from '../invalidation-watcher/registry.js';
import {getPublicationInfo} from '../replicator/tables/published.js';
import type {TableSpec} from '../replicator/tables/specs.js';
import {CVRStore} from './cvr-store.js';
import {ViewSyncerService} from './view-syncer.js';

const EXPECTED_LMIDS_AST: AST = {
  schema: 'zero',
  table: 'clients',
  select: [
    [['clients', 'clientGroupID'], 'clientGroupID'],
    [['clients', 'clientID'], 'clientID'],
    [['clients', 'lastMutationID'], 'lastMutationID'],
  ],
  where: {
    type: 'conjunction',
    op: 'AND',
    conditions: [
      {
        type: 'simple',
        op: '=',
        field: ['clients', 'clientGroupID'],
        value: {type: 'value', value: '9876'},
      },
      {
        type: 'conjunction',
        op: 'OR',
        conditions: [
          {
            type: 'simple',
            op: '=',
            field: ['clients', 'clientID'],
            value: {type: 'value', value: 'foo'},
          },
        ],
      },
    ],
  },
};

describe('view-syncer/service', () => {
  let db: PostgresDB;
  const lc = createSilentLogContext();

  let watcher: MockInvalidationWatcher;
  let vs: ViewSyncerService;
  let viewSyncerDone: Promise<void>;
  let downstream: Queue<Downstream>;

  const SYNC_CONTEXT = {clientID: 'foo', wsID: 'ws1', baseCookie: null};

  beforeEach(async () => {
    db = await testDBs.create('view_syncer_service_test');
    await db`
    CREATE SCHEMA zero;
    CREATE TABLE zero.clients (
      "clientGroupID"  TEXT NOT NULL,
      "clientID"       TEXT NOT NULL,
      "lastMutationID" BIGINT,
      "userID"         TEXT,
      _0_version VARCHAR(38),
      PRIMARY KEY ("clientGroupID", "clientID")
    );
    CREATE TABLE issues (
      id text PRIMARY KEY,
      owner_id text,
      parent_id text,
      big int8,
      title text,
      _0_version VARCHAR(38)
    );
    CREATE TABLE users (
      id text PRIMARY KEY,
      name text,
      _0_version VARCHAR(38)
    );

    INSERT INTO zero.clients ("clientGroupID", "clientID", "lastMutationID", _0_version)
                      VALUES ('9876', 'foo', 42, '0a');

    INSERT INTO users (id, name, _0_version) VALUES ('100', 'Alice', '0a');
    INSERT INTO users (id, name,  _0_version) VALUES ('101', 'Bob', '0b');
    INSERT INTO users (id, name, _0_version) VALUES ('102', 'Candice', '0c');

    INSERT INTO issues (id, title, owner_id, big, _0_version) VALUES ('1', 'parent issue foo', 100, 9007199254740991, '1a0');
    INSERT INTO issues (id, title, owner_id, big, _0_version) VALUES ('2', 'parent issue bar', 101, -9007199254740991, '1ab');
    INSERT INTO issues (id, title, owner_id, parent_id, big, _0_version) VALUES ('3', 'foo', 102, 1, 123, '1ca');
    INSERT INTO issues (id, title, owner_id, parent_id, big, _0_version) VALUES ('4', 'bar', 101, 2, 100, '1cd');
    -- The last row should not match the ISSUES_TITLE_QUERY: "WHERE id IN (1, 2, 3, 4)"
    INSERT INTO issues (id, title, owner_id, parent_id, big, _0_version) VALUES ('5', 'not matched', 101, 2, 100, '1cd');

    CREATE PUBLICATION zero_all FOR ALL TABLES;
    `.simple();

    watcher = new MockInvalidationWatcher();
    vs = new ViewSyncerService(lc, serviceID, watcher, db);
    viewSyncerDone = vs.run();
    downstream = new Queue();
    const stream = await vs.initConnection(SYNC_CONTEXT, [
      'initConnection',
      {
        desiredQueriesPatch: [
          {op: 'put', hash: 'query-hash1', ast: ISSUES_TITLE_QUERY},
        ],
      },
    ]);
    void pipeToQueue(stream, downstream);
  });

  async function pipeToQueue(
    stream: AsyncIterable<Downstream>,
    queue: Queue<Downstream>,
  ) {
    try {
      for await (const msg of stream) {
        await queue.enqueue(msg);
      }
    } catch (e) {
      await queue.enqueueRejection(e);
    }
  }

  afterEach(async () => {
    await vs.stop();
    await viewSyncerDone;
    await testDBs.drop(db);
  });

  const serviceID = '9876';

  const ISSUES_TITLE_QUERY: AST = {
    select: [
      [['issues', 'id'], 'id'],
      [['issues', 'title'], 'title'],
      [['issues', 'big'], 'big'],
    ],
    table: 'issues',
    where: {
      type: 'simple',
      field: ['issues', 'id'],
      op: 'IN',
      value: {
        type: 'value',
        value: ['1', '2', '3', '4'],
      },
    },
  };

  const USERS_NAME_QUERY: AST = {
    select: [
      [['users', 'id'], 'id'],
      [['users', 'name'], 'name'],
    ],
    table: 'users',
  };

  test('initializes schema', async () => {
    await expectTables(db, {
      'cvr.SchemaVersions': [
        {
          // Update versions as necessary
          version: 2,
          maxVersion: 2,
          minSafeRollbackVersion: 1,
          lock: 'v', // Internal column, always 'v'
        },
      ],
    });
  });

  test('adds desired queries from initConnectionMessage', async () => {
    const cvrStore = new CVRStore(lc, db, serviceID);
    const cvr = await cvrStore.load();
    expect(cvr).toMatchObject({
      clients: {
        foo: {
          desiredQueryIDs: ['query-hash1'],
          id: 'foo',
          patchVersion: {stateVersion: '00', minorVersion: 1},
        },
      },
      id: '9876',
      queries: {
        'query-hash1': {
          ast: ISSUES_TITLE_QUERY,
          desiredBy: {foo: {stateVersion: '00', minorVersion: 1}},
          id: 'query-hash1',
        },
      },
      version: {stateVersion: '00', minorVersion: 1},
    });
  });

  test('subscribes and responds to initial invalidation', async () => {
    const request = await watcher.requests.dequeue();
    expect(request.fromVersion).toBeUndefined();
    expect(Object.keys(request.queries).length).toBe(
      2, // including internal "lmids" query
    );

    await watcher.notify({
      fromVersion: null,
      version: '1xz',
      invalidatedQueries: new Set(),
      changes: undefined,
    });

    expect(await downstream.dequeue()).toEqual([
      'pokeStart',
      {pokeID: '1xz', baseCookie: null, cookie: '1xz'},
    ]);
    expect(await downstream.dequeue()).toEqual([
      'pokePart',
      {
        pokeID: '1xz',
        clientsPatch: [{clientID: 'foo', op: 'put'}],
        lastMutationIDChanges: {foo: 42},
        desiredQueriesPatches: {
          foo: [{ast: ISSUES_TITLE_QUERY, hash: 'query-hash1', op: 'put'}],
        },
        entitiesPatch: [
          {
            op: 'put',
            entityID: {id: '1'},
            entityType: 'issues',
            value: {
              id: '1',
              title: 'parent issue foo',
              big: 9007199254740991,
            },
          },
          {
            op: 'put',
            entityID: {id: '2'},
            entityType: 'issues',
            value: {
              id: '2',
              title: 'parent issue bar',
              big: -9007199254740991,
            },
          },
          {
            op: 'put',
            entityID: {id: '3'},
            entityType: 'issues',
            value: {id: '3', title: 'foo', big: 123},
          },
          {
            op: 'put',
            entityID: {id: '4'},
            entityType: 'issues',
            value: {id: '4', title: 'bar', big: 100},
          },
        ],
        gotQueriesPatch: [
          {ast: ISSUES_TITLE_QUERY, hash: 'query-hash1', op: 'put'},
        ],
      } satisfies PokePartBody,
    ]);
    expect(await downstream.dequeue()).toEqual(['pokeEnd', {pokeID: '1xz'}]);

    const cvrStore = new CVRStore(lc, db, serviceID);
    const cvr = await cvrStore.load();
    expect(cvr).toMatchObject({
      clients: {
        foo: {
          desiredQueryIDs: ['query-hash1'],
          id: 'foo',
          patchVersion: {stateVersion: '00', minorVersion: 1},
        },
      },
      id: '9876',
      queries: {
        'lmids': {
          ast: EXPECTED_LMIDS_AST,
          internal: true,
          id: 'lmids',
          transformationVersion: {stateVersion: '1xz'},
        },
        'query-hash1': {
          ast: ISSUES_TITLE_QUERY,
          desiredBy: {foo: {stateVersion: '00', minorVersion: 1}},
          id: 'query-hash1',
          patchVersion: {stateVersion: '1xz'},
          transformationVersion: {stateVersion: '1xz'},
        },
      },
      version: {stateVersion: '1xz'},
    });

    expect(await db`SELECT * FROM cvr.rows`).toEqual([
      {
        clientGroupID: '9876',
        patchVersion: '1xz',
        queriedColumns: {
          lmids: ['clientGroupID', 'clientID', 'lastMutationID'],
        },
        rowKey: {
          clientGroupID: '9876',
          clientID: 'foo',
        },
        rowVersion: '0a',
        schema: 'zero',
        table: 'clients',
      },
      {
        clientGroupID: '9876',
        patchVersion: '1xz',
        queriedColumns: {
          'query-hash1': ['big', 'id', 'title'],
        },
        rowKey: {
          id: '1',
        },
        rowVersion: '1a0',
        schema: 'public',
        table: 'issues',
      },
      {
        clientGroupID: '9876',
        patchVersion: '1xz',
        queriedColumns: {
          'query-hash1': ['big', 'id', 'title'],
        },
        rowKey: {
          id: '2',
        },
        rowVersion: '1ab',
        schema: 'public',
        table: 'issues',
      },
      {
        clientGroupID: '9876',
        patchVersion: '1xz',
        queriedColumns: {
          'query-hash1': ['big', 'id', 'title'],
        },
        rowKey: {
          id: '3',
        },
        rowVersion: '1ca',
        schema: 'public',
        table: 'issues',
      },
      {
        clientGroupID: '9876',
        patchVersion: '1xz',
        queriedColumns: {
          'query-hash1': ['big', 'id', 'title'],
        },
        rowKey: {
          id: '4',
        },
        rowVersion: '1cd',
        schema: 'public',
        table: 'issues',
      },
    ]);
  });

  test('responds to changeQueriesPatch', async () => {
    await watcher.requests.dequeue();

    // Ignore messages from an old websockets.
    await vs.changeDesiredQueries({...SYNC_CONTEXT, wsID: 'old-wsid'}, [
      'changeDesiredQueries',
      {
        desiredQueriesPatch: [
          {op: 'put', hash: 'query-hash-1234567890', ast: USERS_NAME_QUERY},
        ],
      },
    ]);

    // Change the set of queries.
    await vs.changeDesiredQueries(SYNC_CONTEXT, [
      'changeDesiredQueries',
      {
        desiredQueriesPatch: [
          {op: 'put', hash: 'query-hash2', ast: USERS_NAME_QUERY},
          {op: 'del', hash: 'query-hash1'},
        ],
      },
    ]);

    // Should ask the invalidation watcher for a new subscription.
    await watcher.requests.dequeue();

    await watcher.notify({
      fromVersion: null,
      version: '1xz',
      invalidatedQueries: new Set(),
      changes: undefined,
    });

    expect(await downstream.dequeue()).toEqual([
      'pokeStart',
      {pokeID: '1xz', baseCookie: null, cookie: '1xz'},
    ]);
    expect(await downstream.dequeue()).toEqual([
      'pokePart',
      {
        pokeID: '1xz',
        clientsPatch: [{clientID: 'foo', op: 'put'}],
        lastMutationIDChanges: {foo: 42},
        desiredQueriesPatches: {
          foo: [
            {ast: USERS_NAME_QUERY, hash: 'query-hash2', op: 'put'},
            {hash: 'query-hash1', op: 'del'},
          ],
        },
        entitiesPatch: [
          {
            op: 'put',
            entityID: {id: '100'},
            entityType: 'users',
            value: {id: '100', name: 'Alice'},
          },
          {
            op: 'put',
            entityID: {id: '101'},
            entityType: 'users',
            value: {id: '101', name: 'Bob'},
          },
          {
            op: 'put',
            entityID: {id: '102'},
            entityType: 'users',
            value: {id: '102', name: 'Candice'},
          },
        ],
        gotQueriesPatch: [
          {ast: USERS_NAME_QUERY, hash: 'query-hash2', op: 'put'},
          {hash: 'query-hash1', op: 'del'},
        ],
      } satisfies PokePartBody,
    ]);
    expect(await downstream.dequeue()).toEqual(['pokeEnd', {pokeID: '1xz'}]);

    const cvrStore = new CVRStore(lc, db, serviceID);
    const cvr = await cvrStore.load();
    expect(cvr).toMatchObject({
      clients: {
        foo: {
          desiredQueryIDs: ['query-hash2'],
          id: 'foo',
          patchVersion: {stateVersion: '00', minorVersion: 1},
        },
      },
      id: '9876',
      queries: {
        'lmids': {
          ast: EXPECTED_LMIDS_AST,
          internal: true,
          id: 'lmids',
          transformationVersion: {stateVersion: '1xz'},
        },
        'query-hash2': {
          ast: USERS_NAME_QUERY,
          desiredBy: {foo: {stateVersion: '00', minorVersion: 2}},
          id: 'query-hash2',
          patchVersion: {stateVersion: '1xz'},
          transformationVersion: {stateVersion: '1xz'},
        },
      },
      version: {stateVersion: '1xz'},
    });
  });

  const INVALID_QUERY: AST = {
    table: 'users',
    select: [[['users', 'non_existent_column'], 'non_existent_column']],
  };

  test('rejects a bad initConnectionMessage', async () => {
    let err;
    try {
      await vs.initConnection(SYNC_CONTEXT, [
        'initConnection',
        {
          desiredQueriesPatch: [
            {op: 'put', hash: 'bad-query', ast: INVALID_QUERY},
          ],
        },
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeUndefined();

    // Bad client / query should not have been added to the CVR.
    const cvrStore = new CVRStore(lc, db, serviceID);
    const cvr = await cvrStore.load();
    expect(Object.keys(cvr.clients)).not.toContain('boo');
    expect(Object.keys(cvr.queries)).not.toContain('bad-query');
  });

  test('rejects a bad changeQueriesPatch', async () => {
    await watcher.requests.dequeue();

    let err;
    try {
      // Try adding an invalid query.
      await vs.changeDesiredQueries(SYNC_CONTEXT, [
        'changeDesiredQueries',
        {
          desiredQueriesPatch: [
            {op: 'put', hash: 'query-hash3', ast: INVALID_QUERY},
          ],
        },
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeUndefined();

    try {
      // Catch this too so that vite does not flag an unhandled rejection.
      await downstream.dequeue();
      err = undefined;
    } catch (e) {
      expect(e).toBe(err);
    }
    expect(err).not.toBeUndefined();

    // Bad query should not have been added to the CVR.
    const cvrStore = new CVRStore(lc, db, serviceID);
    const cvr = await cvrStore.load();
    expect(cvr).toMatchObject({
      clients: {
        foo: {
          desiredQueryIDs: ['query-hash1'],
          id: 'foo',
          patchVersion: {stateVersion: '00', minorVersion: 1},
        },
      },
      id: '9876',
      queries: {
        'lmids': {
          ast: EXPECTED_LMIDS_AST,
          internal: true,
          id: 'lmids',
        },
        'query-hash1': {
          ast: ISSUES_TITLE_QUERY,
          desiredBy: {foo: {stateVersion: '00', minorVersion: 1}},
          id: 'query-hash1',
        },
      },
    });
  });

  test('fails pokes with error on unsafe integer', async () => {
    // Make one value too large to send back in the current zero-protocol.
    await db`UPDATE issues SET big = 10000000000000000 WHERE id = '4';`;

    await watcher.requests.dequeue();
    await watcher.notify({
      fromVersion: null,
      version: '1xz',
      invalidatedQueries: new Set(),
      changes: undefined,
    });

    let err;
    try {
      for (let i = 0; i < 3; i++) {
        await downstream.dequeue();
      }
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeUndefined();

    // Everything else should succeed, however, because CVRs are agnostic to row
    // contents, and the data in the DB is technically "valid" (and available when
    // the protocol supports it).
    const cvrStore = new CVRStore(lc, db, serviceID);
    const cvr = await cvrStore.load();
    expect(cvr).toMatchObject({
      clients: {
        foo: {
          desiredQueryIDs: ['query-hash1'],
          id: 'foo',
          patchVersion: {stateVersion: '00', minorVersion: 1},
        },
      },
      id: '9876',
      queries: {
        'lmids': {
          ast: EXPECTED_LMIDS_AST,
          internal: true,
          id: 'lmids',
          transformationVersion: {stateVersion: '1xz'},
        },
        'query-hash1': {
          ast: ISSUES_TITLE_QUERY,
          desiredBy: {foo: {stateVersion: '00', minorVersion: 1}},
          id: 'query-hash1',
          patchVersion: {stateVersion: '1xz'},
          transformationVersion: {stateVersion: '1xz'},
        },
      },
      version: {stateVersion: '1xz'},
    });

    await expectTables(db, {
      'cvr.rows': [
        {
          clientGroupID: '9876',
          patchVersion: '1xz',
          queriedColumns: {
            lmids: ['clientGroupID', 'clientID', 'lastMutationID'],
          },
          rowKey: {
            clientGroupID: '9876',
            clientID: 'foo',
          },
          rowVersion: '0a',
          schema: 'zero',
          table: 'clients',
        },
        {
          clientGroupID: '9876',
          patchVersion: '1xz',
          queriedColumns: {
            'query-hash1': ['big', 'id', 'title'],
          },
          rowKey: {
            id: '1',
          },
          rowVersion: '1a0',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: '9876',
          patchVersion: '1xz',
          queriedColumns: {
            'query-hash1': ['big', 'id', 'title'],
          },
          rowKey: {
            id: '2',
          },
          rowVersion: '1ab',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: '9876',
          patchVersion: '1xz',
          queriedColumns: {
            'query-hash1': ['big', 'id', 'title'],
          },
          rowKey: {
            id: '3',
          },
          rowVersion: '1ca',
          schema: 'public',
          table: 'issues',
        },
        {
          clientGroupID: '9876',
          patchVersion: '1xz',
          queriedColumns: {
            'query-hash1': ['big', 'id', 'title'],
          },
          rowKey: {
            id: '4',
          },
          rowVersion: '1cd',
          schema: 'public',
          table: 'issues',
        },
      ],
    });
  });

  test('disconnects on unexpected query result error', async () => {
    // This will result in failing the query parsing.
    await db`UPDATE issues SET _0_version = '' WHERE id = '4';`;

    await watcher.requests.dequeue();
    await watcher.notify({
      fromVersion: null,
      version: '1xz',
      invalidatedQueries: new Set(),
      changes: undefined,
    });

    // TODO(arv): Without a sleep there is sometimes (flaky) unhandled promise
    // rejection from postgres:
    //
    //   Error: write CONNECTION_ENDED
    await sleep(50);

    let err;
    try {
      for (let i = 0; i < 3; i++) {
        await downstream.dequeue();
      }
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeUndefined();
  });

  class MockInvalidationWatcher
    implements InvalidationWatcher, InvalidationWatcherRegistry
  {
    readonly requests = new Queue<WatchRequest>();
    readonly consumed = new Queue<true>();
    subscription: Subscription<QueryInvalidationUpdate> | undefined;

    watch(
      request: WatchRequest,
    ): Promise<CancelableAsyncIterable<QueryInvalidationUpdate>> {
      void this.requests.enqueue(request);
      assert(
        this.subscription === undefined,
        'Only one subscription expected (at a time) in this test',
      );
      this.subscription = Subscription.create<QueryInvalidationUpdate>({
        consumed: () => this.consumed.enqueue(true),
        cleanup: () => (this.subscription = undefined),
      });
      return Promise.resolve(this.subscription);
    }

    async notify(invalidation: Omit<QueryInvalidationUpdate, 'reader'>) {
      const reader = new TransactionPool(lc, Mode.READONLY);
      const readerDone = reader.run(db);

      assert(this.subscription, 'no subscription');
      this.subscription.push({...invalidation, reader});
      await this.consumed.dequeue();

      reader.setDone();
      await readerDone;
    }

    async getTableSchemas(): Promise<readonly TableSpec[]> {
      const published = await getPublicationInfo(db);
      return published.tables;
    }

    getInvalidationWatcher(): Promise<InvalidationWatcher> {
      return Promise.resolve(this);
    }
  }
});