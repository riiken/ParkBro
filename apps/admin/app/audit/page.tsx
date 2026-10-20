'use client';

import { Json, PagedList, short, when } from '../../lib/admin';

interface E {
  id: string;
  actorKind: string;
  actorId: string | null;
  action: string;
  entityKind: string;
  entityId: string;
  metadata: unknown;
  at: string;
}

export default function AuditPage() {
  return (
    <div>
      <h1>Audit log</h1>
      <PagedList<E>
        base="/api/admin/v1/audit"
        filters={[
          { name: 'action', label: 'Action starts with' },
          { name: 'entityKind', label: 'Entity kind' },
          { name: 'entityId', label: 'Entity id' },
          { name: 'actorId', label: 'Actor id' },
        ]}
        rowKey={(e) => e.id}
        columns={[
          { label: 'When', render: (e) => when(e.at) },
          { label: 'Action', render: (e) => e.action },
          { label: 'Entity', render: (e) => `${e.entityKind} ${short(e.entityId)}` },
          { label: 'Actor', render: (e) => `${e.actorKind} ${e.actorId ? short(e.actorId) : ''}` },
          {
            label: 'Details',
            render: (e) =>
              e.metadata && Object.keys(e.metadata as object).length ? <Json value={e.metadata} /> : null,
          },
        ]}
      />
    </div>
  );
}
