'use client';

import { Json, useApi } from '../../lib/admin';

/** Rules in force (read-only; changes ship through code review for the pilot). */
export default function ConfigPage() {
  const { data, error } = useApi<unknown>('/api/admin/v1/config');
  return (
    <div>
      <h1>Configuration</h1>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {data ? <Json value={data} /> : <p aria-busy="true">Loading…</p>}
    </div>
  );
}
