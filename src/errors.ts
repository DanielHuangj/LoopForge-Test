export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'LOGIN_FAILED'
  | 'FORBIDDEN'
  | 'IMAGE_FORBIDDEN'
  | 'NOT_FOUND'
  | 'DISH_INVALID'
  | 'INVALID_IMAGE'
  | 'IMAGE_TOO_LARGE'
  | 'DISH_IN_USE'
  | 'DISH_OFF_SHELF'
  | 'METHOD_NOT_ALLOWED'
  | 'DEMO_CONFLICT'
  | 'VALIDATION_ERROR'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export interface ErrorDetail {
  field: string;
  message: string;
}

export interface ErrorEnvelope {
  code: string;
  message: string;
  traceId: string;
  loginUrl?: string;
  details?: ErrorDetail[];
  status?: 'DOWN';
}

export const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: '请先登录',
  LOGIN_FAILED: '登录失败，请重试',
  FORBIDDEN: '无权访问',
  IMAGE_FORBIDDEN: '无权修改菜品图片',
  NOT_FOUND: '资源不存在',
  DISH_INVALID: '请求参数不合法',
  INVALID_IMAGE: '图片文件不合法',
  IMAGE_TOO_LARGE: '图片不能超过 5 MB',
  DISH_IN_USE: '菜品已被菜单或订单引用，请改为下架',
  DISH_OFF_SHELF: '菜品已下架，不能加入菜单',
  METHOD_NOT_ALLOWED: '请求方法不支持',
  DEMO_CONFLICT: '演示业务冲突',
  VALIDATION_ERROR: '请求参数不合法',
  INTERNAL_ERROR: '服务器内部错误',
  SERVICE_UNAVAILABLE: '服务暂不可用',
};

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  LOGIN_FAILED: 401,
  FORBIDDEN: 403,
  IMAGE_FORBIDDEN: 403,
  NOT_FOUND: 404,
  DISH_INVALID: 422,
  INVALID_IMAGE: 422,
  IMAGE_TOO_LARGE: 413,
  DISH_IN_USE: 409,
  DISH_OFF_SHELF: 409,
  METHOD_NOT_ALLOWED: 405,
  DEMO_CONFLICT: 409,
  VALIDATION_ERROR: 422,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: ErrorDetail[];
  readonly extra?: { status?: 'DOWN' };
  readonly oidcErrorCode?: string;

  constructor(
    code: ErrorCode,
    options: {
      message?: string;
      details?: ErrorDetail[];
      extra?: { status?: 'DOWN' };
      oidcErrorCode?: string;
    } = {},
  ) {
    const message = options.message ?? DEFAULT_MESSAGES[code];
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = DEFAULT_STATUS[code];
    if (options.details) this.details = options.details;
    if (options.extra) this.extra = options.extra;
    if (options.oidcErrorCode !== undefined) this.oidcErrorCode = options.oidcErrorCode;
  }
}

export function buildErrorEnvelope(error: AppError, traceId: string): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    code: error.code,
    message: error.message,
    traceId,
  };
  if (error.code === 'UNAUTHENTICATED') envelope.loginUrl = '/api/v1/auth/login';
  if (error.details && error.details.length > 0) envelope.details = error.details;
  if (error.extra?.status) envelope.status = error.extra.status;
  return envelope;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
