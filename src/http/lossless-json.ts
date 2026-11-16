import type { FastifyInstance } from 'fastify';
import { parse } from 'lossless-json';
import { AppError } from '../errors.js';

export function parseLosslessJson(body: string): unknown {
  try {
    return parse(body);
  } catch {
    throw new AppError('VALIDATION_ERROR');
  }
}

export function registerLosslessJsonParser(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, parseLosslessJson(typeof body === 'string' ? body : body.toString('utf8')));
    } catch (error) {
      done(error as Error);
    }
  });
}
