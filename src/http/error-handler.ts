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

    const imageUploadRoute =
      request.method === 'PUT' && /^\/api\/v1\/admin\/dishes\/[^/]+\/image$/.test(request.url.split('?')[0] ?? '');
    const parserCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

    if (error instanceof AppError) {
      appError = error;
    } else if (imageUploadRoute && (parserCode === 'FST_REQ_FILE_TOO_LARGE' || parserCode === 'FST_ERR_CTP_BODY_TOO_LARGE')) {
      appError = new AppError('IMAGE_TOO_LARGE', {
        message: '图片不能超过 5 MB',
        details: [{ field: 'file', message: '图片不能超过 5 MB' }],
      });
    } else if (imageUploadRoute && (parserCode === 'FST_FILES_LIMIT' || parserCode === 'FST_PARTS_LIMIT')) {
      appError = new AppError('INVALID_IMAGE', {
        message: '文件数量必须为 1',
        details: [{ field: 'file', message: '文件数量必须为 1' }],
      });
    } else if (
      imageUploadRoute &&
      (parserCode === 'FST_INVALID_MULTIPART_CONTENT_TYPE' ||
        parserCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
        parserCode === 'FST_ERR_CTP_EMPTY_JSON_BODY')
    ) {
      appError = new AppError('INVALID_IMAGE', {
        message: '图片上传必须使用 multipart/form-data 且包含一个文件',
        details: [{ field: 'file', message: '图片上传必须使用 multipart/form-data 且包含一个文件' }],
      });
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
      ...(appError.oidcErrorCode
        ? { oidcErrorCode: redactor.redact(appError.oidcErrorCode) }
        : {}),
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
