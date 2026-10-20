'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { FormError } from '../../../components/field';
import { HostGate } from '../../../components/host-gate';
import { formatDate, formatTime } from '../../../lib/booking';
import type { HostProperty } from '../../../lib/host';

interface Gate {
  id: string;
  label: string;
  status: 'ACTIVE' | 'REVOKED';
  expiresAt: string;
}
interface LogEntry {
  kind: string;
  source: string;
  method: string | null;
  gate: string | null;
  plateLast4: string | null;
  unitLabel: string | null;
  at: string;
}

const KIND_LABEL: Record<string, string> = {
  ISSUED: 'Access issued',
  REISSUED: 'New code issued',
  REVOKED: 'Access cancelled',
  VERIFIED: 'Checked: valid',
  DENIED: 'Checked: not valid',
  ENTERED: 'Entered',
  CHECKED_IN: 'Customer arrived',
  PASS_VIEWED: 'Driver pass opened',
};

/** P-04/P-06 for property owners: guard links (shown once, revocable) and the access log. */
export function HostGates() {
  return <HostGate>{() => <Gates />}</HostGate>;
}

function Gates() {
  const [properties, setProperties] = useState<HostProperty[] | null>(null);
  const [propertyId, setPropertyId] = useState('');
  const [gates, setGates] = useState<Gate[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [newLink, setNewLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<HostProperty[]>('/api/v1/host/properties')
      .then((list) => {
        const owned = list.filter((p) => p.relation === 'OWNER');
        setProperties(owned);
        if (owned[0]) setPropertyId(owned[0].id);
      })
      .catch((e: unknown) =>
        setError(e instanceof ApiError ? e.userMessage : 'Could not load your properties.'),
      );
  }, []);

  const load = useCallback(async () => {
    if (!propertyId) return;
    try {
      const [g, l] = await Promise.all([
        apiRequest<Gate[]>(`/api/v1/host/properties/${propertyId}/gates`),
        apiRequest<LogEntry[]>(`/api/v1/host/properties/${propertyId}/access-log`),
      ]);
      setGates(g);
      setLog(l);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not load gates.');
    }
  }, [propertyId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const res = await apiRequest<{ path: string }>(`/api/v1/host/properties/${propertyId}/gates`, {
        method: 'POST',
        body: { label: String(new FormData(event.currentTarget).get('label') ?? '') },
      });
      setNewLink(`${location.origin}${res.path}`);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not create the link.');
    }
  }

  async function revoke(id: string) {
    await apiRequest(`/api/v1/host/properties/${propertyId}/gates/${id}`, { method: 'DELETE' });
    await load();
  }

  if (!properties) return error ? <FormError message={error} /> : <p aria-busy="true">Loading…</p>;
  if (properties.length === 0)
    return (
      <p className="empty">Gate links are for properties you own. Society gates are set up by the society.</p>
    );
  return (
    <div>
      <h1>Gates and access log</h1>
      {properties.length > 1 ? (
        <div className="field">
          <label htmlFor="prop">Property</label>
          <select
            id="prop"
            value={propertyId}
            onChange={(e) => (setPropertyId(e.target.value), setNewLink(null))}
          >
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.address}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <section className="section" aria-labelledby="gates-h">
        <h2 id="gates-h">Guard links</h2>
        <p className="small muted">
          A guard (or you) opens the link to check a vehicle number or code. It shows only whether a booking
          is valid now, the space and the end time. Links expire after 90 days.
        </p>
        {newLink ? (
          <p className="notice" role="status">
            New link (shown once, copy it now): <code>{newLink}</code>
          </p>
        ) : null}
        <ul className="list">
          {gates.map((g) => (
            <li key={g.id}>
              <span>
                {g.label}
                <br />
                <span className="muted small">
                  {g.status === 'ACTIVE' ? `Expires ${formatDate(g.expiresAt)}` : 'Revoked'}
                </span>
              </span>
              {g.status === 'ACTIVE' ? (
                <button type="button" className="link" onClick={() => void revoke(g.id)}>
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        <form onSubmit={create} noValidate className="row-start" aria-label="New guard link">
          <div className="field">
            <label htmlFor="label">Gate name</label>
            <input id="label" name="label" defaultValue="Main gate" maxLength={40} required />
          </div>
          <button type="submit">Create guard link</button>
        </form>
      </section>
      <section className="section" aria-labelledby="log-h">
        <h2 id="log-h">Access log</h2>
        {log.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <ul className="list">
            {log.map((e, i) => (
              <li key={i}>
                <span>
                  {KIND_LABEL[e.kind] ?? e.kind}
                  {e.plateLast4 ? ` · ••${e.plateLast4}` : ''}
                  {e.unitLabel ? ` · space ${e.unitLabel}` : ''}
                </span>
                <span className="small muted">
                  {e.gate ? `${e.gate} · ` : ''}
                  {formatDate(e.at)} {formatTime(e.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <FormError message={error} />
    </div>
  );
}
