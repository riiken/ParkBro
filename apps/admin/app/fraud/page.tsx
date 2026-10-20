'use client';

import Link from 'next/link';
import { useApi } from '../../lib/admin';

interface S {
  kind: string;
  subject: { kind: string; id: string };
  count: number;
  detail: string;
}

const linkFor = (s: S['subject']) =>
  s.kind === 'user'
    ? `/users/${s.id}`
    : s.kind === 'asset'
      ? `/listings/${s.id}`
      : s.kind === 'host_account'
        ? `/listings?hostAccountId=${s.id}`
        : s.kind === 'finance'
          ? '/payments'
          : '#';

/** A-04: signals for a person to look at. Nothing here acts automatically. */
export default function FraudPage() {
  const { data, error } = useApi<S[]>('/api/admin/v1/fraud-indicators');
  return (
    <div>
      <h1>Fraud indicators</h1>
      <p className="muted small">
        Signals only: investigate, then act from the user, host or listing page (with a reason).
      </p>
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      {data?.length === 0 ? <p className="muted">No signals.</p> : null}
      <table className="table">
        <tbody>
          {data?.map((s, i) => (
            <tr key={i}>
              <td>
                <strong>{s.kind}</strong>
              </td>
              <td>{s.detail}</td>
              <td>
                <Link href={linkFor(s.subject)}>Open</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
