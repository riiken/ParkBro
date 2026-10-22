'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { use, useState, type FormEvent } from 'react';
import { ReasonAction, useApi, when } from '../../../lib/admin';

interface Property {
  id: string;
  kind: string;
  displayName: string | null;
  address: string;
  areaLabel: string;
  participationStatus: string;
  outsiderCap: number | null;
  memberHosts: { hostAccountId: string; status: 'ACTIVE' | 'REVOKED' }[];
  createdAt: string;
}

/** Allowed next steps (domain-model §5.2): consent is recorded before residents can list. */
const NEXT: Record<string, string[]> = {
  CONSENT_REQUIRED: ['PENDING_CONSENT'],
  PENDING_CONSENT: ['PARTICIPATING', 'CONSENT_REQUIRED'],
  PARTICIPATING: ['SUSPENDED', 'WITHDRAWN'],
  SUSPENDED: ['PARTICIPATING', 'WITHDRAWN'],
  WITHDRAWN: ['PENDING_CONSENT'],
};

const PARTICIPATION: [string, string][] = [
  ['CONSENT_REQUIRED', 'Consent required (not yet live)'],
  ['PENDING_CONSENT', 'Pending committee consent'],
  ['PARTICIPATING', 'Participating (residents can list)'],
  ['SUSPENDED', 'Suspended'],
  ['WITHDRAWN', 'Withdrawn'],
];

/** Property detail (A-03): the exact address (each view is audited, R-56), society participation and members. */
export default function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: p, error, reload } = useApi<Property>(`/api/admin/properties/${id}`);
  const [memberError, setMemberError] = useState<string | null>(null);
  if (error)
    return (
      <p role="alert" className="form-error">
        {error}
      </p>
    );
  if (!p) return <p aria-busy="true">Loading…</p>;
  const society = p.kind === 'APARTMENT_SOCIETY';

  async function addMember(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const hostAccountId = String(new FormData(form).get('hostAccountId') ?? '').trim();
    setMemberError(null);
    try {
      await apiRequest(`/api/admin/properties/${id}/member-hosts`, {
        method: 'POST',
        body: { hostAccountId },
      });
      form.reset();
      void reload();
    } catch (err) {
      setMemberError(err instanceof ApiError ? err.userMessage : 'Could not add the host.');
    }
  }

  return (
    <div>
      <p>
        <Link href="/properties">← Properties</Link>
      </p>
      <h1>{p.displayName ?? p.areaLabel}</h1>
      <p>
        {p.kind} · {p.areaLabel} · since {when(p.createdAt)}
      </p>
      <div className="panel">
        <h2>Exact address</h2>
        <p>{p.address}</p>
        <p className="small muted">Your view of this address is recorded in the audit log.</p>
      </div>
      {society ? (
        <>
          <div className="panel">
            <h2>Participation</h2>
            <p>
              Now: <strong>{p.participationStatus}</strong>
              {p.outsiderCap ? ` · at most ${p.outsiderCap} outsider spaces at once` : ''}
            </p>
            {(NEXT[p.participationStatus] ?? []).length > 0 ? (
              <ReasonAction
                label="Change participation"
                extra={
                  <select name="status" aria-label="New participation">
                    {PARTICIPATION.filter(([v]) => NEXT[p.participationStatus]?.includes(v)).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                }
                run={(reason, form) =>
                  apiRequest(`/api/admin/properties/${id}/participation`, {
                    method: 'POST',
                    body: { status: String(form.get('status')), reason },
                  }).then(reload)
                }
              />
            ) : null}
          </div>
          <div className="panel">
            <h2>Member hosts</h2>
            {p.memberHosts.length === 0 ? <p className="muted">No member hosts yet.</p> : null}
            <ul>
              {p.memberHosts.map((m) => (
                <li key={m.hostAccountId}>
                  <code className="small">{m.hostAccountId}</code> · {m.status}{' '}
                  {m.status === 'ACTIVE' ? (
                    <button
                      type="button"
                      className="link"
                      onClick={() =>
                        void apiRequest(`/api/admin/properties/${id}/member-hosts/${m.hostAccountId}`, {
                          method: 'DELETE',
                        }).then(reload)
                      }
                    >
                      Remove
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <form onSubmit={addMember} className="filters" aria-label="Add member host" noValidate>
              <label>
                Host account id (from Hosts)
                <input name="hostAccountId" required pattern="[0-9a-f-]{36}" />
              </label>
              <button type="submit">Add member host</button>
            </form>
            {memberError ? (
              <p role="alert" className="form-error">
                {memberError}
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
