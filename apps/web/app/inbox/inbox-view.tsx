'use client';

import { ApiError, apiRequest } from '@parkbro/web-kit';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormError } from '../../components/field';
import { formatDate, formatTime } from '../../lib/booking';

interface Item {
  id: string;
  title: string;
  body: string;
  link: string | null;
  category: 'CRITICAL' | 'TRANSACTIONAL' | 'REMINDER';
  read: boolean;
  createdAt: string;
}

/** In-app notifications (Phase 18): every message also lands here, whatever the other channels did. */
export function InboxView() {
  const router = useRouter();
  const [data, setData] = useState<{ unread: number; items: Item[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await apiRequest<{ unread: number; items: Item[] }>('/api/v1/me/notifications'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return router.replace('/sign-in?next=/inbox');
      setError(e instanceof ApiError ? e.userMessage : 'Could not load notifications.');
    }
  }, [router]);
  useEffect(() => {
    void load();
  }, [load]);

  async function markAll() {
    await apiRequest('/api/v1/me/notifications/read', { method: 'POST', body: { all: true } });
    await load();
  }
  async function open(item: Item) {
    if (!item.read)
      await apiRequest('/api/v1/me/notifications/read', { method: 'POST', body: { ids: [item.id] } }).catch(
        () => undefined,
      );
    if (item.link) router.push(item.link);
    else await load();
  }

  if (error) return <FormError message={error} />;
  if (!data) return <p aria-busy="true">Loading…</p>;
  return (
    <div>
      <div className="row">
        <h1>Notifications</h1>
        {data.unread > 0 ? (
          <button type="button" className="link" onClick={() => void markAll()}>
            Mark all read
          </button>
        ) : null}
      </div>
      {data.items.length === 0 ? (
        <p className="empty">
          Nothing yet. Booking updates appear here. <Link href="/search">Find parking</Link>
        </p>
      ) : (
        <ul className="list">
          {data.items.map((i) => (
            <li key={i.id} className={i.read ? undefined : 'unread'}>
              <button type="button" className="link inbox-item" onClick={() => void open(i)}>
                <strong>
                  {i.category === 'CRITICAL' ? '⚠ ' : ''}
                  {i.title}
                </strong>
                <br />
                <span className="small">{i.body}</span>
              </button>
              <span className="small muted">
                {formatDate(i.createdAt)} {formatTime(i.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
