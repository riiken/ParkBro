'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import { useId, useState, type FormEvent } from 'react';
import { CONNECTOR_LABEL, VEHICLE_LABEL } from '../lib/format';
import { FormError } from './field';

export interface Vehicle {
  id: string;
  plate: string;
  vehicleClass: string;
  isEv: boolean;
  connectors: string[];
  nickname: string | null;
}

/**
 * Add a vehicle (C-05, account). Shared by the booking box and the account page so both behave the same: an EV
 * must say which connectors it takes (several are common, e.g. CCS2 + Type 2), which drives charger matching.
 */
export function VehicleForm({
  evByDefault = false,
  onSaved,
  onCancel,
}: {
  evByDefault?: boolean;
  onSaved: (vehicle: Vehicle) => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const [isEv, setIsEv] = useState(evByDefault);
  const [connectors, setConnectors] = useState<string[]>(evByDefault ? ['CCS2'] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (isEv && connectors.length === 0) {
      setError('Choose the connector(s) your car takes.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nickname = String(form.get('nickname') ?? '').trim();
      const vehicle = await apiRequest<Vehicle>('/api/v1/me/vehicles', {
        method: 'POST',
        body: {
          plate: String(form.get('plate') ?? ''),
          vehicleClass: String(form.get('vehicleClass') ?? 'HATCHBACK'),
          isEv,
          connectors: isEv ? connectors : [],
          ...(nickname ? { nickname } : {}),
        },
      });
      onSaved(vehicle);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not save the vehicle.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Add your vehicle">
      <h3>Add your vehicle</h3>
      <p className="small muted">Hosts and guards see your number plate during the booking.</p>
      <div className="field">
        <label htmlFor={`${id}-plate`}>Registration number</label>
        <input
          id={`${id}-plate`}
          name="plate"
          placeholder="KA 01 AB 1234"
          autoCapitalize="characters"
          required
          maxLength={20}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-class`}>Vehicle type</label>
        <select id={`${id}-class`} name="vehicleClass" defaultValue="HATCHBACK">
          {Object.entries(VEHICLE_LABEL).map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-nickname`}>Nickname (optional)</label>
        <input id={`${id}-nickname`} name="nickname" maxLength={30} placeholder="e.g. Office car" />
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={isEv}
          onChange={(e) => {
            setIsEv(e.target.checked);
            if (e.target.checked && connectors.length === 0) setConnectors(['CCS2']);
          }}
        />{' '}
        Electric vehicle
      </label>
      {isEv ? (
        <fieldset>
          <legend>Charging connectors it takes</legend>
          <div className="checks">
            {Object.entries(CONNECTOR_LABEL).map(([v, label]) => (
              <label key={v} className="check">
                <input
                  type="checkbox"
                  checked={connectors.includes(v)}
                  onChange={(e) =>
                    setConnectors((c) => (e.target.checked ? [...c, v] : c.filter((x) => x !== v)))
                  }
                />{' '}
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <FormError message={error} />
      <div className="row-start">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save vehicle'}
        </button>
        {onCancel ? (
          <button type="button" className="link" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
