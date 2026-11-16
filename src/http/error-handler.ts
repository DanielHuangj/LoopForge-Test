import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { AppError, buildErrorEnvelope } from '../errors.js';
import type { Redactor } from '../logger.js';

function fastifyValidationDetails(error: FastifyError): Array<{ field: string; message: string }> {
  if (!error.validation) return [];
  return error.validation.map((item) => ({
    field: String(item.instancePath?.replace(/^\//, '').replace(/\//g, '.') || item.params?.missingProperty || 'request'),
    message: item.message || '参数不合法',
  }));
}

export function registerErrorHandler(app: FastifyInstance, logger: Logger, redactor: Redactor): void {
  app.setErrorHandler((error: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply) => {
    let appError: AppError;

    if (error instanceof AppError) {
      appError = error;
    } else if (error.validation) {
      appError = new AppError('VALIDATION_ERROR', { details: fastifyValidationDetails(error) });
    } else if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      appError = new AppError('VALIDATION_ERROR');
    } else {
      appError = new AppError('INTERNAL_ERROR');
    }

    reply.header('X-Trace-Id', request.id);
    reply.type('application/json; charset=utf-8');

    const errorType = error instanceof Error ? error.name : 'Error';
    const rawMessage = error instanceof Error ? error.message : 'unknown error';
    const safeMessage = redactor.redact(rawMessage);
    const base = {
      event: 'http_error',
      traceId: request.id,
      errorCode: appError.code,
      errorType,
      message: appError.status >= 500 ? safeMessage : appError.message,
    };

    if (appError.status >= 500) {
      const stack = error instanceof Error && error.stack ? redactor.redact(error.stack) : undefined;
      logger.error({ ...base, ...(stack ? { stack } : {}) });
    } else {
      logger.warn(base);
    }

    return reply.code(appError.status).send(buildErrorEnvelope(appError, request.id));
  });
}
