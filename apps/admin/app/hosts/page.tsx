'use client';

import { useState } from 'react';
import { apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { PagedList, ReasonAction, when } from '../../lib/admin';

interface H {
  id: string;
  displayName: string;
  kind: string;
  status: string;
  ownerUserId: string | null;
  createdAt: string;
}

export default function HostsPage() {
  const [refresh, setRefresh] = useState(0);
  return (
    <div>
      <h1>Host accounts</h1>
      <p className="muted small">
        Restricted or suspended hosts disappear from search and can&apos;t edit listings; existing bookings
        stand.
      </p>
      <PagedList<H>
        refresh={refresh}
        base="/api/admin/v1/hosts"
        filters={[
          { name: 'q', label: 'Name' },
          {
            name: 'status',
            label: 'Status',
            options: [
              ['ACTIVE', 'Active'],
              ['RESTRICTED', 'Restricted'],
              ['SUSPENDED', 'Suspended'],
            ],
          },
        ]}
        rowKey={(h) => h.id}
        columns={[
          {
            label: 'Host',
            render: (h) =>
              h.ownerUserId ? <Link href={`/users/${h.ownerUserId}`}>{h.displayName}</Link> : h.displayName,
          },
          {
            label: 'Account id',
            render: (h) => <code className="small">{h.id}</code>, // needed to add a host to a society
          },
          { label: 'Kind', render: (h) => h.kind },
          { label: 'Status', render: (h) => h.status },
          { label: 'Since', render: (h) => when(h.createdAt) },
          { label: 'Listings', render: (h) => <Link href={`/listings?hostAccountId=${h.id}`}>View</Link> },
          {
            label: 'Change status',
            render: (h) => (
              <ReasonAction
                label="Set status"
                extra={
                  <select
                    name="status"
                    defaultValue={h.status === 'ACTIVE' ? 'RESTRICTED' : 'ACTIVE'}
                    aria-label="New status"
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="RESTRICTED">Restricted</option>
                    <option value="SUSPENDED">Suspended</option>
                  </select>
                }
                run={(reason, f) =>
                  apiRequest(`/api/admin/v1/hosts/${h.id}/status`, {
                    method: 'POST',
                    body: { reason, status: String(f.get('status')) },
                  }).then(() => setRefresh((n) => n + 1))
                }
              />
            ),
          },
        ]}
      />
    </div>
  );
}
