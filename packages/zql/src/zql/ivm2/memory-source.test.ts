import {expect, test} from 'vitest';
import {Ordering} from '../ast2/ast.js';
import {compareRowsTest} from './data.test.js';
import {MemorySource} from './memory-source.js';
import {runCases} from './test/source-cases.js';
import {ValueType} from './schema.js';
import {Catch} from './catch.js';

runCases(
  (
    _name: string,
    columns: Record<string, ValueType>,
    primaryKeys: readonly string[],
  ) => new MemorySource(columns, primaryKeys),
);

test('schema', () => {
  compareRowsTest((order: Ordering) => {
    const ms = new MemorySource({a: 'string'}, ['a']);
    const connector = ms.connect(order);
    const out = new Catch(connector);
    return connector.getSchema(out).compareRows;
  });
});

test('indexes get cleaned up when not needed', () => {
  const ms = new MemorySource({a: 'string', b: 'string', c: 'string'}, ['a']);
  expect(ms.getIndexKeys()).toEqual([JSON.stringify([['a', 'asc']])]);

  const conn1 = ms.connect([['b', 'asc']]);
  const c1 = new Catch(conn1);
  c1.hydrate();
  expect(ms.getIndexKeys()).toEqual([
    JSON.stringify([['a', 'asc']]),
    JSON.stringify([['b', 'asc']]),
  ]);

  const conn2 = ms.connect([['b', 'asc']]);
  const c2 = new Catch(conn2);
  c2.hydrate();
  expect(ms.getIndexKeys()).toEqual([
    JSON.stringify([['a', 'asc']]),
    JSON.stringify([['b', 'asc']]),
  ]);

  const conn3 = ms.connect([['c', 'asc']]);
  const c3 = new Catch(conn3);
  c3.hydrate();
  expect(ms.getIndexKeys()).toEqual([
    JSON.stringify([['a', 'asc']]),
    JSON.stringify([['b', 'asc']]),
    JSON.stringify([['c', 'asc']]),
  ]);

  ms.disconnect(conn3);
  expect(ms.getIndexKeys()).toEqual([
    JSON.stringify([['a', 'asc']]),
    JSON.stringify([['b', 'asc']]),
  ]);

  ms.disconnect(conn2);
  expect(ms.getIndexKeys()).toEqual([
    JSON.stringify([['a', 'asc']]),
    JSON.stringify([['b', 'asc']]),
  ]);

  ms.disconnect(conn1);
  expect(ms.getIndexKeys()).toEqual([JSON.stringify([['a', 'asc']])]);
});