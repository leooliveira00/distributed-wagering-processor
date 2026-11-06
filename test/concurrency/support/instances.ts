import { type Subprocess } from 'bun';
import { type Env } from '../../../src/infrastructure/config/env';

export interface Instance {
  url: string;
  process: Subprocess;
}

export interface Cluster {
  instances: Instance[];
  /** Picks instances round-robin, so consecutive requests land on different processes. */
  next(): Instance;
  stop(): Promise<void>;
}

const BOOT_TIMEOUT_MS = 60_000;

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  void probe.stop(true);
  if (port === undefined) throw new Error('could not reserve a free port');
  return port;
}

async function waitUntilLive(url: string, process: Subprocess): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(
        `instance at ${url} exited during boot with code ${String(process.exitCode)}`,
      );
    }
    try {
      const response = await fetch(`${url}/health/live`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`instance at ${url} did not become live in ${String(BOOT_TIMEOUT_MS)}ms`);
}

/**
 * Starts `count` real application processes (`bun src/main.ts`) sharing one database. Nothing is
 * shared in memory between them: any correctness has to come from PostgreSQL.
 */
export async function startCluster(count: number, env: Env): Promise<Cluster> {
  const instances: Instance[] = [];
  try {
    for (let index = 0; index < count; index++) {
      const port = freePort();
      const child = Bun.spawn([process.execPath, 'src/main.ts'], {
        cwd: `${import.meta.dir}/../../..`,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(port),
          APP_ROLES: 'api',
          LOG_LEVEL: 'warn',
          DATABASE_HOST: env.DATABASE_HOST,
          DATABASE_PORT: String(env.DATABASE_PORT),
          DATABASE_NAME: env.DATABASE_NAME,
          DATABASE_USER: env.DATABASE_USER,
          DATABASE_PASSWORD: env.DATABASE_PASSWORD,
          DATABASE_POOL_MAX: '10',
        },
        stdout: 'ignore',
        stderr: 'inherit',
      });
      instances.push({ url: `http://127.0.0.1:${String(port)}`, process: child });
    }
    await Promise.all(instances.map((instance) => waitUntilLive(instance.url, instance.process)));
  } catch (error) {
    for (const instance of instances) instance.process.kill();
    throw error;
  }

  let cursor = 0;
  return {
    instances,
    next() {
      const instance = instances[cursor % instances.length];
      cursor++;
      if (!instance) throw new Error('cluster has no instances');
      return instance;
    },
    async stop() {
      for (const instance of instances) instance.process.kill();
      await Promise.all(instances.map((instance) => instance.process.exited));
    },
  };
}
