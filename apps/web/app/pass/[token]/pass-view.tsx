'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import { useEffect, useState } from 'react';
import { formatTime, formatWhen } from '../../../lib/booking';

interface Pass {
  status: string;
  code: string | null;
  plate: string;
  unitLabel: string | null;
  validFrom: string;
  validUntil: string;
  address: string | null;
  instructions: string | null;
}

/** Driver pass (trust-and-safety §10.1): a shared, time-limited link for one booking; no account needed. */
export function PassView({ token }: { token: string }) {
  const [pass, setPass] = useState<Pass | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiRequest<Pass>(`/api/v1/access/pass/${encodeURIComponent(token)}`)
      .then(setPass)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.title : 'This pass could not be loaded.'));
  }, [token]);
  if (error) return <p className="notice">{error}. Ask the person who booked for a new link.</p>;
  if (!pass) return <p aria-busy="true">Loading pass…</p>;
  return (
    <div>
      <h1>Parking pass</h1>
      {pass.code && pass.status !== 'EXPIRED' && pass.status !== 'REVOKED' ? (
        <p className="pass-code">{pass.code}</p>
      ) : null}
      <p>
        Vehicle <strong>{pass.plate}</strong>
        {pass.unitLabel ? (
          <>
            {' '}
            · space <strong>{pass.unitLabel}</strong>
          </>
        ) : null}
      </p>
      <p>{formatWhen(pass.validFrom, pass.validUntil)}</p>
      {pass.address ? <p>{pass.address}</p> : null}
      {pass.instructions ? <p className="notice">{pass.instructions}</p> : null}
      <p className="small muted">
        Show the code or the number plate at the gate. Valid until {formatTime(pass.validUntil)} for this
        vehicle only.
      </p>
    </div>
  );
}
