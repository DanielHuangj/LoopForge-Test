import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, getFreePort, type TestDatabase } from './helpers/database.js';

const SESSION_SECRET = 'test-session-secret-0123456789abcdef0123456789abcdef';

interface ServerProcess {
  child: ChildProcess;
  baseUrl: string;
  output(): string;
}

interface TcpProxy {
  url(original: string): string;
  close(): Promise<void>;
}

async function startServer(databaseUrl: string): Promise<ServerProcess> {
  const appPort = await getFreePort();
  const mockPort = await getFreePort();
  const output: string[] = [];
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      APP_ENV: 'dev',
      PORT: String(appPort),
      DATABASE_URL: databaseUrl,
      SSO_MODE: 'mock',
      SESSION_SECRET,
      MOCK_SSO_PORT: String(mockPort),
      MOCK_SSO_ISSUER: `http://127.0.0.1:${mockPort}`,
      HEALTH_DB_TIMEOUT_MS: '2000',
      LOG_LEVEL: 'warn',
      OBJECT_STORAGE_DRIVER: 's3',
      OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
      OBJECT_STORAGE_REGION: 'us-east-1',
      OBJECT_STORAGE_BUCKET: 'loopforge-dish-images',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
      OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return { child, baseUrl: `http://127.0.0.1:${appPort}`, output: () => output.join('') };
}

/** A TCP proxy whose sockets can be destroyed abruptly, simulating a lost database connection. */
async function startTcpProxy(targetUrl: string): Promise<TcpProxy> {
  const target = new URL(targetUrl);
  const targetPort = Number(target.port);
  const openSockets = new Set<Socket>();
  const proxy = createServer((client) => {
    const upstream = connect(targetPort, target.hostname);
    openSockets.add(client);
    openSockets.add(upstream);
    const destroyBoth = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', destroyBoth);
    upstream.on('error', destroyBoth);
    client.on('close', () => openSockets.delete(client));
    upstream.on('close', () => openSockets.delete(upstream));
    client.pipe(upstream);
    upstream.pipe(client);
  });
  const proxyPort = await getFreePort();
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(proxyPort, '127.0.0.1', () => resolve());
  });
  return {
    url(original: string): string {
      const url = new URL(original);
      url.port = String(proxyPort);
      return url.toString();
    },
    async close(): Promise<void> {
      for (const socket of openSockets) socket.destroy();
      openSockets.clear();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}

async function probeStatus(url: string, timeoutMs: number): Promise<number> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return 0;
  }
}

async function waitForHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeStatus(url, 2000)) === 200) return;
    await delay(100);
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

async function waitForOutput(server: ServerProcess, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.output().includes(needle)) return true;
    await delay(100);
  }
  return false;
}

describe('database outage resilience', () => {
  let database: TestDatabase | undefined;
  let proxy: TcpProxy | undefined;
  let server: ServerProcess | undefined;

  afterEach(async () => {
    const child = server?.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await Promise.race([exited, delay(3000)]);
    }
    server = undefined;
    if (proxy) {
      await proxy.close().catch(() => undefined);
      proxy = undefined;
    }
    if (database) {
      await database.close().catch(() => undefined);
      database = undefined;
    }
  });

  it('survives an abruptly lost connection and answers 503 within 5 seconds', async (ctx) => {
    database = await createTestDatabase();
    if (database.kind !== 'pglite') {
      ctx.skip();
    }
    proxy = await startTcpProxy(database.url);
    const running = await startServer(proxy.url(database.url));
    server = running;
    const healthUrl = `${running.baseUrl}/healthz`;
    await waitForHealthy(healthUrl, 30_000);
    expect(running.child.exitCode).toBeNull();

    // Health probes established pooled connections; dropping the proxy sockets kills them abruptly.
    const dropped = proxy;
    proxy = undefined;
    await dropped.close();

    expect(await waitForOutput(running, 'database_pool_error', 5000)).toBe(true);
    expect(running.child.exitCode).toBeNull();

    const startedAt = Date.now();
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    const elapsedMs = Date.now() - startedAt;
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(elapsedMs).toBeLessThan(5000);
    expect(body).toMatchObject({ status: 'DOWN', code: 'SERVICE_UNAVAILABLE' });
    expect(typeof body.traceId).toBe('string');
    expect(running.child.exitCode).toBeNull();
  }, 60_000);
});
