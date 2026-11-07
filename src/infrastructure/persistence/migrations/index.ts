import { type MigrationObject } from '@mikro-orm/core';
import { Migration20261106000100_initial_schema } from './Migration20261106000100_initial_schema';
import { Migration20261106000200_ledger_integrity } from './Migration20261106000200_ledger_integrity';
import { Migration20261106000300_pending_dependents_index } from './Migration20261106000300_pending_dependents_index';
import { Migration20261107000400_pending_processing_failures } from './Migration20261107000400_pending_processing_failures';

/**
 * Migrations are registered explicitly (instead of glob discovery) so the same list runs
 * identically under Bun, Docker and tests. Order matters: append new migrations at the end.
 */
export const migrations: MigrationObject[] = [
  { name: 'Migration20261106000100_initial_schema', class: Migration20261106000100_initial_schema },
  {
    name: 'Migration20261106000200_ledger_integrity',
    class: Migration20261106000200_ledger_integrity,
  },
  {
    name: 'Migration20261106000300_pending_dependents_index',
    class: Migration20261106000300_pending_dependents_index,
  },
  {
    name: 'Migration20261107000400_pending_processing_failures',
    class: Migration20261107000400_pending_processing_failures,
  },
];
