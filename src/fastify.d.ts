import type { UserRecord } from './db/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: UserRecord;
    startTimeNs?: bigint;
  }
}
