'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Field, FormError } from '../../components/field';

interface Profile {
  id: string;
  displayName: string;
  phoneMasked: string;
  locale: 'en' | 'hi' | 'kn';
  roles: string[];
}
interface SessionRow {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string | null;
}

const LANGUAGES = { en: 'English', hi: 'हिन्दी (Hindi)', kn: 'ಕನ್ನಡ (Kannada)' } as const;

function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  if (/iPhone|iPad/.test(userAgent)) return 'iPhone / iPad';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Macintosh/.test(userAgent)) return 'Mac';
  if (/Windows/.test(userAgent)) return 'Windows';
  return 'Browser';
}

/** Account (ux-architecture C-19): profile, language, signed-in devices, sign out. */
export function AccountView() {
  const router = useRouter();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [me, devices] = await Promise.all([
        apiRequest<Profile>('/api/v1/me'),
        apiRequest<SessionRow[]>('/api/v1/me/sessions'),
      ]);
      setProfile(me);
      setSessions(devices);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.replace('/sign-in?next=/account');
        return;
      }
      setLoadError(e instanceof ApiError ? e.userMessage : 'Could not load your account.');
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setFieldErrors({});
    setSaved(false);
    try {
      setProfile(
        await apiRequest<Profile>('/api/v1/me', {
          method: 'PATCH',
          body: {
            displayName: String(form.get('displayName') ?? ''),
            locale: String(form.get('locale') ?? 'en'),
          },
        }),
      );
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not save.');
      if (e instanceof ApiError) setFieldErrors(e.fieldErrors);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await apiRequest(`/api/v1/me/sessions/${id}`, { method: 'DELETE' });
    await load();
  }

  async function signOut() {
    await apiRequest('/api/v1/auth/logout', { method: 'POST' });
    router.replace('/sign-in');
  }

  if (loadError) {
    return (
      <div>
        <FormError message={loadError} />
        <button type="button" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }
  if (!profile) return <p aria-busy="true">Loading your account…</p>;

  return (
    <div className="stack">
      <h1>Your account</h1>
      <p className="muted">Signed in as {profile.phoneMasked}</p>

      <form onSubmit={onSave} noValidate>
        <h2>Profile</h2>
        <Field
          id="displayName"
          name="displayName"
          label="Your name"
          defaultValue={profile.displayName}
          maxLength={60}
          required
          error={fieldErrors.displayName}
        />
        <div className="field">
          <label htmlFor="locale">Language</label>
          <select id="locale" name="locale" defaultValue={profile.locale}>
            {Object.entries(LANGUAGES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <FormError message={error} />
        {saved ? (
          <p role="status" className="success">
            Saved.
          </p>
        ) : null}
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </form>

      <NotificationPreferences />

      <YourData />

      <section aria-labelledby="devices-heading">
        <h2 id="devices-heading">Signed-in devices</h2>
        <ul className="list">
          {sessions.map((s) => (
            <li key={s.id}>
              <span>
                {describeDevice(s.userAgent)}
                {s.current ? ' · This device' : ''}
                <br />
                <span className="muted small">Last active {new Date(s.lastSeenAt).toLocaleString()}</span>
              </span>
              {s.current ? null : (
                <button type="button" className="link" onClick={() => void revoke(s.id)}>
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <button type="button" className="secondary" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}

type Prefs = { whatsapp: boolean; sms: boolean; email: boolean; push: boolean };

/** Channel opt-outs (Phase 18). Urgent messages (e.g. a customer stuck at your gate) still use SMS. */
function NotificationPreferences() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  useEffect(() => {
    apiRequest<Prefs>('/api/v1/me/notification-preferences')
      .then(setPrefs)
      .catch(() => setPrefs(null));
  }, []);
  async function toggle(key: 'whatsapp' | 'sms', value: boolean) {
    setPrefs(
      await apiRequest<Prefs>('/api/v1/me/notification-preferences', {
        method: 'PUT',
        body: { [key]: value },
      }),
    );
  }
  if (!prefs) return null;
  return (
    <section aria-labelledby="notif-heading">
      <h2 id="notif-heading">Notifications</h2>
      <p className="small muted">Everything also appears in your inbox in the app.</p>
      <label className="check">
        <input
          type="checkbox"
          checked={prefs.whatsapp}
          onChange={(e) => void toggle('whatsapp', e.target.checked)}
        />{' '}
        WhatsApp
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.sms} onChange={(e) => void toggle('sms', e.target.checked)} />{' '}
        SMS (used when WhatsApp is off)
      </label>
      <p className="small muted">
        Urgent messages, like a customer who can&apos;t get in, are always sent by SMS.
      </p>
    </section>
  );
}

interface DataRequest {
  id: string;
  kind: 'ACCESS' | 'CORRECTION' | 'ERASURE';
  status: 'OPEN' | 'COMPLETED' | 'REJECTED';
  dueAt: string;
  resolution: string | null;
  createdAt: string;
}
const REQUEST_LABEL = {
  ACCESS: 'A copy of my data',
  CORRECTION: 'Correct my data',
  ERASURE: 'Delete my account and data',
} as const;

/** Data rights (DPDP, D-169): ask for a copy, a correction or erasure; we reply by the date shown. */
function YourData() {
  const [requests, setRequests] = useState<DataRequest[] | null>(null);
  const [kind, setKind] = useState<DataRequest['kind'] | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    apiRequest<DataRequest[]>('/api/v1/me/data-requests')
      .then(setRequests)
      .catch(() => setRequests(null));
  }, []);
  useEffect(load, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!kind) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest('/api/v1/me/data-requests', {
        method: 'POST',
        body: { kind, ...(details.trim() ? { details: details.trim() } : {}) },
      });
      setKind(null);
      setDetails('');
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.userMessage : 'Could not send your request. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!requests) return null;
  return (
    <section aria-labelledby="data-heading">
      <h2 id="data-heading">Your data</h2>
      <p className="small muted">
        Ask for a copy of your data, a correction, or to delete your account. We reply by the date shown.
        Booking and payment records we must keep by law are retained without your personal details.
      </p>
      {kind ? (
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="data-details">{REQUEST_LABEL[kind]}: anything we should know (optional)</label>
            <textarea
              id="data-details"
              maxLength={500}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </div>
          {kind === 'ERASURE' ? (
            <p className="small">
              Your account will be closed and your personal details removed. Open bookings must finish first.
            </p>
          ) : null}
          <FormError message={error} />
          <button type="submit" disabled={busy} className={kind === 'ERASURE' ? 'danger' : undefined}>
            {busy ? 'Sending…' : 'Send request'}
          </button>{' '}
          <button type="button" className="link" onClick={() => setKind(null)}>
            Cancel
          </button>
        </form>
      ) : (
        <p className="link-row">
          {(Object.keys(REQUEST_LABEL) as DataRequest['kind'][]).map((k) => (
            <button key={k} type="button" className="link" onClick={() => setKind(k)}>
              {REQUEST_LABEL[k]}
            </button>
          ))}
        </p>
      )}
      {requests.length > 0 ? (
        <ul className="list">
          {requests.map((r) => (
            <li key={r.id}>
              <span>
                {REQUEST_LABEL[r.kind]} ·{' '}
                {r.status === 'OPEN'
                  ? `we'll reply by ${new Date(r.dueAt).toLocaleDateString()}`
                  : r.status === 'COMPLETED'
                    ? 'done'
                    : 'declined'}
                {r.resolution ? <span className="muted small"> · {r.resolution}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
