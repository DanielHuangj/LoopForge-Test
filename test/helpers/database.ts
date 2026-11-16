import { randomBytes } from 'node:crypto';
import { createServer as createNetServer, connect } from 'node:net';
import pg from 'pg';

export interface TestDatabase {
  url: string;
  close(): Promise<void>;
  kind: 'external' | 'testcontainers' | 'pglite';
}

function canReachDocker(): Promise<boolean> {
  return new Promise((resolve) => {
    const socketPath = process.env.DOCKER_HOST?.startsWith('unix://')
      ? process.env.DOCKER_HOST.slice('unix://'.length)
      : '/var/run/docker.sock';
    const socket = connect(socketPath);
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('could not allocate a port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function startPglite(): Promise<{ url: string; close(): Promise<void> }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { createServer } = await import('pglite-server');
  const db = new PGlite();
  await db.waitReady;
  const port = await getFreePort();
  const server = createServer(db);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (process.env.TEST_DATABASE_URL) {
    const baseUrl = new URL(process.env.TEST_DATABASE_URL);
    const schema = `loopforge_test_${randomBytes(6).toString('hex')}`;
    const setup = new pg.Client({ connectionString: baseUrl.toString() });
    await setup.connect();
    await setup.query(`CREATE SCHEMA "${schema}"`);
    await setup.end();

    const isolatedUrl = new URL(baseUrl);
    isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
    return {
      url: isolatedUrl.toString(),
      kind: 'external',
      close: async () => {
        const cleanup = new pg.Client({ connectionString: baseUrl.toString() });
        await cleanup.connect();
        try {
          await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          await cleanup.end();
        }
      },
    };
  }

  if (await canReachDocker()) {
    try {
      const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
      const container = await new PostgreSqlContainer('postgres:16-alpine').start();
      return {
        url: container.getConnectionUri(),
        kind: 'testcontainers',
        close: async () => {
          await container.stop();
        },
      };
    } catch {
      // Fall through to the embedded wire server when Docker cannot start a container.
    }
  }

  const pglite = await startPglite();
  return { url: pglite.url, kind: 'pglite', close: pglite.close };
}

export async function tableRows<T extends pg.QueryResultRow>(
  databaseUrl: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

export async function execute(databaseUrl: string, sql: string, params: unknown[] = []): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}
