'use client';

import Link from 'next/link';
import { useApi, when } from '../../lib/admin';

interface D {
  id: string;
  category: string;
  risk: 'LOW' | 'HIGH';
  status: string;
  openedBy: string;
  requestedOutcome: string;
  createdAt: string;
}

/** A-03 dispute queue: high risk first, then oldest. */
export default function DisputesPage() {
  const { data, error } = useApi<D[]>('/api/admin/v1/disputes');
  return (
    <div>
      <h1>Disputes</h1>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {!data ? (
        <p aria-busy="true">Loading…</p>
      ) : data.length === 0 ? (
        <p className="muted">No open disputes.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Opened</th>
              <th>Category</th>
              <th>Risk</th>
              <th>By</th>
              <th>Wants</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id}>
                <td>{when(d.createdAt)}</td>
                <td>
                  <Link href={`/disputes/${d.id}`}>{d.category}</Link>
                </td>
                <td>
                  <span className={`badge ${d.risk === 'HIGH' ? 'high' : ''}`}>{d.risk}</span>
                </td>
                <td>{d.openedBy}</td>
                <td>{d.requestedOutcome}</td>
                <td>{d.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
