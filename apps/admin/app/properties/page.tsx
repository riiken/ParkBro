'use client';

import { PagedList, when } from '../../lib/admin';

interface P {
  id: string;
  kind: string;
  displayName: string | null;
  areaLabel: string;
  participationStatus: string;
  createdAt: string;
}

export default function PropertiesPage() {
  return (
    <div>
      <h1>Properties</h1>
      <p className="muted small">Lists never show exact addresses.</p>
      <PagedList<P>
        base="/api/admin/v1/properties"
        filters={[
          { name: 'q', label: 'Area or name' },
          {
            name: 'kind',
            label: 'Kind',
            options: [
              ['INDEPENDENT_HOUSE', 'House'],
              ['APARTMENT_SOCIETY', 'Society'],
              ['COMMERCIAL', 'Commercial'],
              ['OFFICE', 'Office'],
              ['OTHER', 'Other'],
            ],
          },
          {
            name: 'participation',
            label: 'Participation',
            options: [
              ['NOT_REQUIRED', 'Not required'],
              ['PARTICIPATING', 'Participating'],
              ['CONSENT_REQUIRED', 'Consent required'],
              ['SUSPENDED', 'Suspended'],
            ],
          },
        ]}
        rowKey={(p) => p.id}
        columns={[
          { label: 'Name', render: (p) => p.displayName ?? '—' },
          { label: 'Area', render: (p) => p.areaLabel },
          { label: 'Kind', render: (p) => p.kind },
          { label: 'Participation', render: (p) => p.participationStatus },
          { label: 'Created', render: (p) => when(p.createdAt) },
        ]}
      />
    </div>
  );
}
