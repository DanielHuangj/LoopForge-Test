import { isLosslessNumber } from 'lossless-json';
import { AppError } from '../errors.js';
import type { CreateDishInput, SaleStatus, UpdateDishInput } from './dish-models.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRICE_TEXT = /^[1-9][0-9]*$/;
const MAX_PRICE_TEXT = '9223372036854775807';
const EDITABLE_FIELDS = new Set(['name', 'category', 'description', 'reference_price_cents']);

function invalid(field: string, message: string): AppError {
  return new AppError('DISH_INVALID', { details: [{ field, message }] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalid('request', '请求体必须为 JSON 对象');
  return value;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizeRequiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw invalid(field, '必填且必须为字符串');
  const normalized = value.trim();
  if (normalized.length === 0) throw invalid(field, '不能为空');
  if (codePointLength(normalized) > max) throw invalid(field, `长度不能超过 ${max} 个字符`);
  return normalized;
}

function normalizeDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid('description', '必须为字符串或 null');
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (codePointLength(normalized) > 300) throw invalid('description', '长度不能超过 300 个字符');
  return normalized;
}

export function validatePriceCents(value: unknown, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (!isLosslessNumber(value)) {
    throw invalid('reference_price_cents', '必须为大于 0 的整数分');
  }
  const text = value.value;
  if (!PRICE_TEXT.test(text)) {
    throw invalid('reference_price_cents', '必须为大于 0 的整数分');
  }
  if (text.length > MAX_PRICE_TEXT.length || (text.length === MAX_PRICE_TEXT.length && text > MAX_PRICE_TEXT)) {
    throw invalid('reference_price_cents', '不能超过 BIGINT 最大值');
  }
  return text;
}

export function parseCreateDish(body: unknown): CreateDishInput {
  const input = requiredObject(body);
  return {
    name: normalizeRequiredText(input.name, 'name', 60),
    category: normalizeRequiredText(input.category, 'category', 30),
    description: normalizeDescription(input.description),
    referencePriceCents: validatePriceCents(input.reference_price_cents)!,
  };
}

export function parseUpdateDish(body: unknown): UpdateDishInput {
  const input = requiredObject(body);
  const unknown = Object.keys(input).find((key) => !EDITABLE_FIELDS.has(key));
  if (unknown) throw invalid(unknown, '不支持修改该字段');
  const entries = Object.keys(input).filter((key) => EDITABLE_FIELDS.has(key));
  if (entries.length === 0) throw invalid('request', '至少提供一个可编辑字段');

  const update: UpdateDishInput = {};
  if ('name' in input) update.name = normalizeRequiredText(input.name, 'name', 60);
  if ('category' in input) update.category = normalizeRequiredText(input.category, 'category', 30);
  if ('description' in input) update.description = normalizeDescription(input.description);
  if ('reference_price_cents' in input) {
    update.referencePriceCents = validatePriceCents(input.reference_price_cents);
  }
  return update;
}

export function parseSaleStatus(body: unknown): SaleStatus {
  const input = requiredObject(body);
  if (input.sale_status !== 'ON_SALE' && input.sale_status !== 'OFF_SHELF') {
    throw invalid('sale_status', '只允许 ON_SALE 或 OFF_SHELF');
  }
  return input.sale_status;
}

export function isUuidV4(value: string): boolean {
  return UUID_V4.test(value);
}

export function assertUuidV4(value: string, field: string): string {
  if (!isUuidV4(value)) throw new AppError('NOT_FOUND', { details: [{ field, message: '资源不存在' }] });
  return value;
}
