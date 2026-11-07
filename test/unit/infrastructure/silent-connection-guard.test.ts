import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  discardSilentConnections,
  QUERY_READ_TIMEOUT_MESSAGE,
} from '../../../src/infrastructure/persistence/silent-connection-guard';

/** A pool emitting `connect` with a client whose next query settles as given. */
function connectClient(outcome: () => Promise<unknown>) {
  const pool = new EventEmitter();
  discardSilentConnections(pool);
  const socket = { destroyed: false, destroy: () => (socket.destroyed = true) };
  const client: { query: (sql: string) => unknown; connection: { stream: typeof socket } } = {
    query: () => outcome(),
    connection: { stream: socket },
  };
  pool.emit('connect', client);
  return { client, socket };
}

describe('discardSilentConnections', () => {
  it('destroys the socket of a connection whose query got no answer, and still rejects', async () => {
    const { client, socket } = connectClient(() =>
      Promise.reject(new Error(QUERY_READ_TIMEOUT_MESSAGE)),
    );

    expect(client.query('select 1')).rejects.toThrow(QUERY_READ_TIMEOUT_MESSAGE);
    await Bun.sleep(0);
    expect(socket.destroyed).toBe(true);
  });

  it('keeps the connection after a query error the server answered', async () => {
    const { client, socket } = connectClient(() =>
      Promise.reject(new Error('duplicate key value violates unique constraint')),
    );

    expect(client.query('insert ...')).rejects.toThrow('duplicate key');
    await Bun.sleep(0);
    expect(socket.destroyed).toBe(false);
  });

  it('keeps the connection after a successful query and returns its result', async () => {
    const { client, socket } = connectClient(() => Promise.resolve({ rows: [{ x: 1 }] }));

    expect(await client.query('select 1')).toEqual({ rows: [{ x: 1 }] });
    expect(socket.destroyed).toBe(false);
  });
});
