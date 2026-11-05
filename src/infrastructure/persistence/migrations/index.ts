import { type MigrationObject } from '@mikro-orm/core';

/**
 * Migrations are registered explicitly (instead of glob discovery) so the same list runs
 * identically under Bun, Docker and tests. Order matters: append new migrations at the end.
 */
export const migrations: MigrationObject[] = [];
