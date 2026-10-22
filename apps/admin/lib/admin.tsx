'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

export interface Page<T> {
  items: T[];
  offset: number;
  limit: number;
  total: number;
}

const rupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});
export const money = (paise: number | null | undefined) => (paise == null ? '—' : rupees.format(paise / 100));
export const when = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: 'numeric',
        month: 'short',
        year: '2-digit',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso))
    : '—';
export const short = (id: string) => id.slice(0, 8);

/** GET with loading/error state; `reload` re-fetches. */
export function useApi<T>(url: string | null) {
  const router = useRouter();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!url) return;
    setError(null);
    try {
      setData(await apiRequest<T>(url));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace('/sign-in');
      setError(e instanceof ApiError ? e.userMessage : 'Request failed.');
    }
  }, [url, router]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload, setData };
}

/** A paged list with URL-free filters (admin views are internal; no deep links needed beyond detail pages). */
export function PagedList<T>({
  base,
  filters,
  columns,
  rowKey,
  empty = 'Nothing found.',
  refresh = 0,
}: {
  base: string;
  /** Bump after an action on a row so the list shows the new state (filters and page are kept). */
  refresh?: number;
  filters?: { name: string; label: string; options?: [string, string][] }[];
  columns: { label: string; render: (row: T) => ReactNode }[];
  rowKey: (row: T) => string;
  empty?: string;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [offset, setOffset] = useState(0);
  const limit = 25;
  const qs = new URLSearchParams({
    ...Object.fromEntries(Object.entries(values).filter(([, v]) => v)),
    offset: String(offset),
    limit: String(limit),
  });
  if (refresh) qs.set('_r', String(refresh));
  const { data, error } = useApi<Page<T>>(`${base}${base.includes('?') ? '&' : '?'}${qs}`);

  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setValues(Object.fromEntries((filters ?? []).map((x) => [x.name, String(f.get(x.name) ?? '').trim()])));
    setOffset(0);
  }

  return (
    <div>
      {filters?.length ? (
        <form onSubmit={apply} className="filters" aria-label="Filters">
          {filters.map((x) => (
            <label key={x.name}>
              {x.label}
              {x.options ? (
                <select name={x.name} defaultValue="">
                  <option value="">Any</option>
                  {x.options.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              ) : (
                <input name={x.name} />
              )}
            </label>
          ))}
          <button type="submit">Apply</button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {!data ? (
        <p aria-busy="true">Loading…</p>
      ) : data.items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.label} scope="col">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((c) => (
                    <td key={c.label}>{c.render(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pager">
            <span className="muted">
              {data.offset + 1}–{data.offset + data.items.length} of {data.total}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              Previous
            </button>
            <button
              type="button"
              className="secondary"
              disabled={offset + limit >= data.total}
              onClick={() => setOffset(offset + limit)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Every state-changing admin action asks for a reason (ux §3.6), which the API records in the audit log.
 * `extra` renders more inputs inside the same form.
 */
export function ReasonAction({
  label,
  run,
  danger,
  extra,
  minLength = 5,
  placeholder = 'Reason (recorded in the audit log)',
}: {
  label: string;
  run: (reason: string, form: FormData) => Promise<unknown>;
  danger?: boolean;
  extra?: ReactNode;
  minLength?: number;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await run(String(f.get('reason') ?? '').trim(), f);
      setDone(true);
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.userMessage : 'Failed.');
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <span>
        <button
          type="button"
          className={danger ? 'danger' : 'secondary'}
          onClick={() => (setOpen(true), setDone(false))}
        >
          {label}
        </button>
        {done ? <span className="success"> Done</span> : null}
      </span>
    );
  return (
    <form onSubmit={submit} className="reason" aria-label={label}>
      {extra}
      <input name="reason" required minLength={minLength} placeholder={placeholder} aria-label="Reason" />
      <button type="submit" disabled={busy} className={danger ? 'danger' : undefined}>
        {busy ? 'Working…' : `Confirm: ${label}`}
      </button>
      <button type="button" className="link" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export const IdLink = ({ href, id }: { href: string; id: string }) => (
  <Link href={href} title={id}>
    {short(id)}
  </Link>
);

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
