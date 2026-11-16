import pg from 'pg';

export interface PoolOptions {
  onError?: (error: Error) => void;
}

export function createPool(databaseUrl: string, options: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    application_name: 'loopforge-base-auth',
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
  const check = pool.query({ text: 'SELECT 1', query_timeout: timeoutMs } as pg.QueryConfig);
  try {
    await Promise.race([check, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closePool(pool: pg.Pool): Promise<void> {
  await pool.end();
}
