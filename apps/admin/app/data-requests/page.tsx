'use client';

import { apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useState } from 'react';
import { PagedList, ReasonAction, short, when } from '../../lib/admin';

interface DataRequest {
  id: string;
  userId: string;
  kind: 'ACCESS' | 'CORRECTION' | 'ERASURE';
  details: string | null;
  status: string;
  dueAt: string;
  resolution: string | null;
  createdAt: string;
}

/**
 * Data-rights requests (DPDP, D-169), oldest due first. Fulfil per the runbook (production-readiness §6), then record
 * the outcome; every step is audited.
 */
export default function DataRequests() {
  const [status, setStatus] = useState('OPEN');
  const [version, setVersion] = useState(0);
  return (
    <div>
      <h1>Data requests</h1>
      <div className="filters">
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="OPEN">Open</option>
            <option value="COMPLETED">Completed</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </label>
      </div>
      <PagedList<DataRequest>
        key={`${status}-${version}`}
        base={`/api/admin/v1/data-requests?status=${status}`}
        rowKey={(r) => r.id}
        empty="No requests."
        columns={[
          {
            label: 'Due',
            render: (r) => (
              <span className={r.status === 'OPEN' && Date.parse(r.dueAt) < Date.now() ? 'error' : undefined}>
                {when(r.dueAt)}
              </span>
            ),
          },
          { label: 'Kind', render: (r) => r.kind },
          { label: 'User', render: (r) => <Link href={`/users/${r.userId}`}>{short(r.userId)}</Link> },
          { label: 'Details', render: (r) => r.details ?? '—' },
          {
            label: 'Outcome',
            render: (r) =>
              r.status === 'OPEN' ? (
                <>
                  <ReasonAction
                    label="Mark done"
                    placeholder="What was done (e.g. export sent, anonymised per runbook)"
                    run={(resolution) =>
                      apiRequest(`/api/admin/v1/data-requests/${r.id}/resolve`, {
                        method: 'POST',
                        body: { status: 'COMPLETED', resolution },
                      }).then(() => setVersion((v) => v + 1))
                    }
                  />{' '}
                  <ReasonAction
                    label="Decline"
                    danger
                    placeholder="Why (shown to the customer)"
                    run={(resolution) =>
                      apiRequest(`/api/admin/v1/data-requests/${r.id}/resolve`, {
                        method: 'POST',
                        body: { status: 'REJECTED', resolution },
                      }).then(() => setVersion((v) => v + 1))
                    }
                  />
                </>
              ) : (
                `${r.status.toLowerCase()} · ${r.resolution ?? ''}`
              ),
          },
        ]}
      />
    </div>
  );
}
