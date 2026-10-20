'use client';

import Link from 'next/link';
import { PagedList, when } from '../../lib/admin';

interface U {
  id: string;
  displayName: string;
  phoneMasked: string;
  status: string;
  roles: string[];
  createdAt: string;
}

export default function UsersPage() {
  return (
    <div>
      <h1>Users</h1>
      <PagedList<U>
        base="/api/admin/v1/users"
        filters={[
          { name: 'q', label: 'Exact phone or name' },
          {
            name: 'status',
            label: 'Status',
            options: [
              ['ACTIVE', 'Active'],
              ['SUSPENDED', 'Suspended'],
              ['CLOSED', 'Closed'],
            ],
          },
        ]}
        rowKey={(u) => u.id}
        columns={[
          { label: 'Name', render: (u) => <Link href={`/users/${u.id}`}>{u.displayName}</Link> },
          { label: 'Phone', render: (u) => u.phoneMasked },
          { label: 'Roles', render: (u) => u.roles.join(', ') },
          { label: 'Status', render: (u) => u.status },
          { label: 'Joined', render: (u) => when(u.createdAt) },
        ]}
      />
    </div>
  );
}
