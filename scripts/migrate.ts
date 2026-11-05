import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../src/infrastructure/config/env';
import { buildMikroOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';

type Command = 'up' | 'down' | 'status';

function parseCommand(value: string | undefined): Command {
  if (value === 'up' || value === 'down' || value === 'status') return value;
  throw new Error(`Usage: bun scripts/migrate.ts <up|down|status> (received "${value ?? ''}")`);
}

const command = parseCommand(process.argv[2]);
const orm = await MikroORM.init(buildMikroOrmConfig(loadEnv()));

try {
  const migrator = orm.migrator;
  if (command === 'up') {
    const applied = await migrator.up();
    console.log(
      `Applied ${applied.length} migration(s)${applied.length ? ': ' + applied.map((m) => m.name).join(', ') : ''}`,
    );
  } else if (command === 'down') {
    // Reverts only the last executed migration, one step at a time.
    const reverted = await migrator.down();
    console.log(
      `Reverted ${reverted.length} migration(s)${reverted.length ? ': ' + reverted.map((m) => m.name).join(', ') : ''}`,
    );
  } else {
    const executed = await migrator.getExecuted();
    const pending = await migrator.getPending();
    console.log(`Executed: ${executed.map((m) => m.name).join(', ') || '(none)'}`);
    console.log(`Pending:  ${pending.map((m) => m.name).join(', ') || '(none)'}`);
  }
} finally {
  await orm.close();
}
