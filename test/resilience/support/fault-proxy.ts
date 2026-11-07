import { type Socket, type TCPSocketListener } from 'bun';

/**
 * How the proxy treats traffic:
 * - `pass`: bytes flow both ways, as if the proxy were not there;
 * - `refuse`: open connections are reset and new ones are closed at once (a dependency that
 *   restarts or rejects connections);
 * - `blackhole`: connections are accepted and kept, but nothing goes through in either
 *   direction (a network partition: the client hears nothing and gets no error either).
 */
export type FaultMode = 'pass' | 'refuse' | 'blackhole';

export interface FaultProxy {
  readonly port: number;
  readonly mode: FaultMode;
  setMode(mode: FaultMode): void;
  close(): void;
}

interface Link {
  upstream?: Socket<Link>;
  /** Client bytes received before the upstream connection was ready. */
  early: Uint8Array[];
  /** Bytes the kernel did not accept yet, per direction. */
  toUpstream: Uint8Array[];
  toClient: Uint8Array[];
  /** Set when the link was cut while in `blackhole`: it never forwards again. */
  frozen: boolean;
  client?: Socket<Link>;
}

function flush(socket: Socket<Link> | undefined, queue: Uint8Array[]): void {
  if (!socket) return;
  while (queue.length > 0) {
    const chunk = queue[0];
    if (!chunk) return;
    const written = socket.write(chunk);
    if (written < chunk.length) {
      queue[0] = chunk.subarray(Math.max(written, 0));
      return; // the rest goes out on `drain`
    }
    queue.shift();
  }
}

/**
 * A TCP proxy between the application and one dependency, controlled by the test. It makes an
 * outage real (sockets reset or silent) without stopping the shared container other suites use.
 */
export function startFaultProxy(target: { host: string; port: number }): FaultProxy {
  let mode: FaultMode = 'pass';
  const links = new Set<Link>();

  const cut = (link: Link) => {
    links.delete(link);
    link.client?.terminate();
    link.upstream?.terminate();
  };

  const connectUpstream = (link: Link) => {
    void Bun.connect<Link>({
      hostname: target.host,
      port: target.port,
      data: link,
      socket: {
        open(upstream) {
          if (!links.has(link) || link.frozen) {
            upstream.terminate();
            return;
          }
          link.upstream = upstream;
          link.toUpstream.push(...link.early);
          link.early = [];
          flush(upstream, link.toUpstream);
        },
        data(_upstream, chunk) {
          if (link.frozen) return;
          link.toClient.push(new Uint8Array(chunk));
          flush(link.client, link.toClient);
        },
        drain(upstream) {
          flush(upstream, link.toUpstream);
        },
        close() {
          if (links.has(link)) cut(link);
        },
        error() {
          if (links.has(link)) cut(link);
        },
        connectError() {
          if (links.has(link)) cut(link);
        },
      },
    }).catch(() => {
      if (links.has(link)) cut(link);
    });
  };

  const listener: TCPSocketListener<Link> = Bun.listen<Link>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        const link: Link = {
          early: [],
          toUpstream: [],
          toClient: [],
          frozen: mode === 'blackhole',
          client,
        };
        client.data = link;
        if (mode === 'refuse') {
          client.terminate();
          return;
        }
        links.add(link);
        if (mode === 'pass') connectUpstream(link);
      },
      data(client, chunk) {
        const link = client.data;
        if (link.frozen) return; // swallowed: the client waits for an answer that never comes
        const bytes = new Uint8Array(chunk);
        if (!link.upstream) {
          link.early.push(bytes);
          return;
        }
        link.toUpstream.push(bytes);
        flush(link.upstream, link.toUpstream);
      },
      drain(client) {
        flush(client, client.data.toClient);
      },
      close(client) {
        if (links.has(client.data)) cut(client.data);
      },
      error(client) {
        if (links.has(client.data)) cut(client.data);
      },
    },
  });

  return {
    port: listener.port,
    get mode() {
      return mode;
    },
    setMode(next: FaultMode) {
      mode = next;
      for (const link of [...links]) {
        if (next === 'refuse') cut(link);
        // A partition does not close sockets: they just stop carrying bytes, for good. When
        // the network comes back, the client has to notice and open new connections.
        if (next === 'blackhole') link.frozen = true;
        if (next === 'pass' && link.frozen) cut(link);
      }
    },
    close() {
      for (const link of [...links]) cut(link);
      listener.stop(true);
    },
  };
}
