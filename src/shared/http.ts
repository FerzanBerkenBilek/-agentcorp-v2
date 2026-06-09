/**
 * Shared HTTP response envelope types and helpers.
 *
 * Every endpoint returns a discriminated union: `{ success: true, data }` or
 * `{ success: false, error }`. Keeping this in one place guarantees a uniform
 * contract for the frontend and for QA assertions.
 */

/** Successful response envelope. */
export interface ApiSuccess<T> {
  success: true;
  data: T;
}

/** Error response envelope (shape produced by the global error handler). */
export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Pagination metadata returned alongside list results. */
export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** A paginated list payload. */
export interface Paginated<T> {
  items: T[];
  pageInfo: PageMeta;
}

/**
 * Wrap a value in the success envelope.
 *
 * @param data The payload to return.
 * @returns An ApiSuccess envelope.
 */
export function ok<T>(data: T): ApiSuccess<T> {
  return { success: true, data };
}

/**
 * Build pagination metadata from raw counts.
 *
 * @param page Current 1-based page number.
 * @param limit Page size.
 * @param total Total matching rows.
 * @returns Page metadata including computed totalPages.
 */
export function buildPageMeta(page: number, limit: number, total: number): PageMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}
