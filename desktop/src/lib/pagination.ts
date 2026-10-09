/**
 * Bounded rendering for large reports: the table renders one page at a time
 * (the browser edition rendered all filtered rows at once; the desktop build
 * must stay responsive at the 20,000-device cap, so it paginates).
 *
 * `paginate` is pure and total: any requested page number is clamped into the
 * valid range, so a shrinking result set can never produce an empty page
 * beyond the end.
 */

/** Rows per page. Fixed by design; no page-size selector. */
export const PAGE_SIZE = 50;

export interface Page<T> {
  /** The rows to render (at most `pageSize`). */
  items: T[];
  /** 1-based page number, clamped into [1, pageCount]. */
  page: number;
  /** Total number of pages; always >= 1 (an empty list has one empty page). */
  pageCount: number;
  /** Total number of items. */
  total: number;
  /** 1-based index of the first rendered row; 0 when the list is empty. */
  from: number;
  /** 1-based index of the last rendered row; 0 when the list is empty. */
  to: number;
}

export function paginate<T>(items: readonly T[], requestedPage: number, pageSize: number = PAGE_SIZE): Page<T> {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safeRequested = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1;
  const page = Math.min(Math.max(1, safeRequested), pageCount);
  const start = (page - 1) * pageSize;
  const slice = items.slice(start, start + pageSize);
  return {
    items: slice,
    page,
    pageCount,
    total,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
  };
}
