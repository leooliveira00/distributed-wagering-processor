import { type Subprocess } from 'bun';
import { type Env } from '../../../src/infrastructure/config/env';

export interface Instance {
  url: string;
  process: Subprocess;
  /** Raw stdout lines written so far; empty unless spawned with `captureStdout`. */
  stdoutLines(): string[];
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
 * Spawns one real application process (`bun src/main.ts`) without waiting for it to be live.
 * `overrides` are extra environment variables, e.g. APP_ROLES or FAULT_INJECTION.
 */
export function spawnInstance(
  env: Env,
  overrides: Record<string, string> = {},
  options: { captureStdout?: boolean } = {},
): Instance {
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
      AWS_REGION: env.AWS_REGION,
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
      ...(env.AWS_ENDPOINT_URL ? { AWS_ENDPOINT_URL: env.AWS_ENDPOINT_URL } : {}),
      ...overrides,
    },
    stdout: options.captureStdout ? 'pipe' : 'ignore',
    stderr: 'inherit',
  });
  const lines: string[] = [];
  if (options.captureStdout && child.stdout instanceof ReadableStream) {
    // Drained continuously: an unread pipe would eventually block the child's writes.
    void (async () => {
      let pending = '';
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true });
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        lines.push(...parts.filter((line) => line.trim().length > 0));
      }
    })();
  }
  return {
    url: `http://127.0.0.1:${String(port)}`,
    process: child,
    stdoutLines: () => [...lines],
  };
}

export { waitUntilLive };

/**
 * Starts `count` real application processes sharing one database and waits until all are live.
 * Nothing is shared in memory between them: any correctness has to come from PostgreSQL.
 */
export async function startCluster(
  count: number,
  env: Env,
  overrides: Record<string, string> = {},
): Promise<Cluster> {
  const instances: Instance[] = [];
  try {
    for (let index = 0; index < count; index++) instances.push(spawnInstance(env, overrides));
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
