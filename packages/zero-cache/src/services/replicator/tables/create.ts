import type {ColumnSpec, TableSpec} from './specs.js';

/**
 * Constructs a `CREATE TABLE` statement for a {@link TableSpec}.
 */
export function createTableStatement(spec: TableSpec): string {
  function colDef(name: string, colSpec: ColumnSpec): string {
    const parts = [`${name} ${colSpec.dataType}`];
    if (colSpec.characterMaximumLength !== null) {
      parts.push(`(${colSpec.characterMaximumLength})`);
    }
    if (colSpec.columnDefault) {
      parts.push(` DEFAULT ${colSpec.columnDefault}`);
    }
    return parts.join('');
  }

  const defs = Object.entries(spec.columns).map(([name, col]) =>
    colDef(name, col),
  );
  if (spec.primaryKey) {
    defs.push(`PRIMARY KEY (${spec.primaryKey.join(',')})`);
  }

  return [
    `CREATE TABLE ${spec.schema}.${spec.name} (`,
    defs.join(',\n'),
    ');',
  ].join('\n');
}