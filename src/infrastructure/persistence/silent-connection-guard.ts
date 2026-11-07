/**
 * The parts of `pg`'s Client and Pool this guard touches. Structural on purpose: `pg` is a
 * transitive dependency (through @mikro-orm/postgresql), not one the application imports.
 */
interface PgClientLike {
  query: (...args: unknown[]) => unknown;
  connection?: { stream?: { destroy: () => void } };
}

interface PgPoolLike {
  on(event: 'connect', listener: (client: PgClientLike) => void): unknown;
}

/** Message `pg` (8.x) rejects with when `query_timeout` fires. It carries no code. */
export const QUERY_READ_TIMEOUT_MESSAGE = 'Query read timeout';

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === 'object' &&
  value !== null &&
  'then' in value &&
  typeof value.then === 'function';

/**
 * Discards a connection as soon as one of its queries gets no answer.
 *
 * When `query_timeout` fires, `pg` rejects the query but keeps the connection waiting for the
 * reply. Outside a transaction nothing marks it as broken, so it goes back to the pool and every
 * later query on it queues behind a reply that never comes: after a network partition, the pool
 * stays poisoned until the OS notices the dead socket, which can take hours.
 *
 * Destroying the socket makes `pg` flag the client as not queryable, so the pool removes it on
 * release (or at once, if idle). The caller still gets the original rejection.
 */
export function discardSilentConnections(pool: PgPoolLike): void {
  pool.on('connect', (client) => {
    const query = client.query.bind(client);
    client.query = (...args: unknown[]) => {
      const result = query(...args);
      if (isPromiseLike(result)) {
        result.then(undefined, (error: unknown) => {
          if (error instanceof Error && error.message === QUERY_READ_TIMEOUT_MESSAGE) {
            client.connection?.stream?.destroy();
          }
        });
      }
      return result;
    };
  });
}
