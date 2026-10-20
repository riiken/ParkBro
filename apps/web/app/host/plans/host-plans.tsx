'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FormError } from '../../../components/field';
import { HostGate } from '../../../components/host-gate';
import { PLAN_STATUS_LABEL, formatDate, formatRupees, type PlanView } from '../../../lib/booking';

/** H-11 monthly arrangements per space. */
export function HostPlans() {
  return <HostGate>{() => <List />}</HostGate>;
}

function List() {
  const [plans, setPlans] = useState<PlanView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiRequest<PlanView[]>('/api/v1/host/series')
      .then(setPlans)
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.userMessage : 'Could not load monthly plans.'),
      );
  }, []);
  if (error) return <FormError message={error} />;
  if (!plans) return <p aria-busy="true">Loading…</p>;
  return (
    <div>
      <h1>Monthly plans</h1>
      {plans.length === 0 ? (
        <p className="empty">
          No monthly plans yet. Add a monthly price to a 24/7 listing to receive requests.
        </p>
      ) : (
        <ul className="list">
          {plans.map((p) => (
            <li key={p.id}>
              <span>
                <Link href={`/host/plans/${p.id}`}>
                  {p.customer?.name ?? 'Customer'} · {p.listing.title}
                </Link>
                <br />
                <span className="muted small">
                  From {formatDate(p.anchorStart)} · {formatRupees(p.periodPricePaise)}/month
                  {p.unitLabel ? ` · space ${p.unitLabel}` : ''}
                </span>
              </span>
              <span className={`status status-${p.status.toLowerCase()}`}>{PLAN_STATUS_LABEL[p.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
