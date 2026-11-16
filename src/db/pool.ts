import pg from 'pg';

export interface PoolOptions {
  onError?: (error: Error) => void;
  connectionTimeoutMillis?: number;
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
}

export function createPool(databaseUrl: string, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    application_name: 'loopforge-base-auth',
    ...(options.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
    ...(options.statementTimeoutMs === undefined ? {} : { statement_timeout: options.statementTimeoutMs }),
    ...(options.queryTimeoutMs === undefined ? {} : { query_timeout: options.queryTimeoutMs }),
  });
  // An idle client that loses its connection emits 'error' on the pool. Without a
  // listener Node treats it as an uncaught exception and terminates the process, so
  // the health check can never report the outage.
  pool.on('error', (error: Error) => {
    options.onError?.(error);
  });
  return pool;
}

export async function checkDatabase(pool: pg.Pool, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('database health check timed out')), timeoutMs);
    timer.unref();
  });
  const connection = pool.connect();
  let client: pg.PoolClient | undefined;
  let destroyConnection = false;
  try {
    client = await Promise.race([connection, timeout]);
    await Promise.race([
      client.query({ text: 'SELECT 1', query_timeout: timeoutMs } as pg.QueryConfig),
      timeout,
    ]);
  } catch (error) {
    destroyConnection = true;
    if (!client) {
      void connection.then((lateClient) => lateClient.release(true)).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    client?.release(destroyConnection);
  }
}

export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
