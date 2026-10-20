'use client';

import { useState } from 'react';
import { money, useApi } from '../../lib/admin';

type Rate = number | null;
interface Overview {
  window: { start: string; end: string; days: number };
  supply: {
    hosts: { total: number; new: number; live: number; withBookings: number };
    byType: {
      assetType: string;
      publishedListings: number;
      activeUnits: number;
      openUnitHours: number;
      bookedUnitHours: number;
      utilisation: Rate;
    }[];
    utilisation: Rate;
  };
  demand: {
    customers: { total: number; new: number; withBookings: number };
    searches: { total: number; zeroResult: number; zeroResultRate: Rate; withTimeWindow: number };
    listingViews: number;
    bookings: { requested: number; confirmed: number; successRate: Rate };
    conversion: { searchToBooking: Rate; viewToBooking: Rate };
    repeatCustomers: number;
    repeatRate: Rate;
  };
  marketplace: {
    gmvPaise: number;
    refundsPaise: number;
    netGmvPaise: number;
    platformRevenuePaise: number;
    commissionPaise: number;
    serviceFeePaise: number;
    taxPaise: number;
    averageBookingValuePaise: number | null;
    cancellation: { rate: Rate; byCustomer: number; byHost: number; byPlatform: number };
    noShowRate: Rate;
    retention: { hosts: Rate; customers: Rate };
  };
  daily: {
    day: string;
    searches: number;
    zeroResultSearches: number;
    confirmedBookings: number;
    gmvPaise: number;
  }[];
}
interface Liquidity {
  areas: {
    cell: string;
    areaLabel: string | null;
    searches: number;
    zeroResultSearches: number;
    zeroResultRate: Rate;
    publishedListings: number;
    confirmedBookings: number;
  }[];
}

interface AiUsage {
  configured: { provider: string; model: string } | null;
  dailyBudgetUsd: number;
  spentTodayUsd: number;
  rows: {
    feature: string;
    provider: string;
    model: string | null;
    calls: number;
    modelAnswers: number;
    fallbacks: { noProvider: number; budget: number; timeout: number; error: number; invalidOutput: number };
    latencyMs: { p50: number | null; p95: number | null };
    p95TotalMs: number | null;
    tokens: { input: number; output: number };
    costUsd: number;
    toolCalls: number;
    averageFieldsUnderstood: number | null;
    nothingUnderstood: number;
    feedback: { helpful: number; notHelpful: number };
  }[];
}

const pct = (r: Rate) => (r == null ? '—' : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`);
const TYPE: Record<string, string> = { PARKING: 'Parking', EV_CHARGING: 'EV charging' };

function Cards({ items }: { items: [string, string | number, string?][] }) {
  return (
    <div className="cards">
      {items.map(([label, value, hint]) => (
        <div key={label} className="card">
          <strong>{value}</strong>
          {label}
          {hint ? <div className="small muted">{hint}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** Daily bars as SVG (attributes, not inline styles, so the CSP holds). */
function Trend({
  label,
  values,
  format,
}: {
  label: string;
  values: { day: string; v: number }[];
  format: (v: number) => string;
}) {
  const max = Math.max(1, ...values.map((x) => x.v));
  const w = 8;
  const total = values.reduce((s, x) => s + x.v, 0);
  return (
    <figure className="trend">
      <figcaption>
        {label} <span className="muted">· {format(total)} total</span>
      </figcaption>
      <svg viewBox={`0 0 ${values.length * w} 40`} preserveAspectRatio="none" role="img" aria-label={label}>
        {values.map((x, i) => {
          const h = (x.v / max) * 38;
          return (
            <rect key={x.day} x={i * w + 1} y={40 - h} width={w - 2} height={h} className="bar">
              <title>{`${x.day}: ${format(x.v)}`}</title>
            </rect>
          );
        })}
      </svg>
    </figure>
  );
}

/**
 * Marketplace analytics (Phase 21, docs/analytics.md): liquidity first. Every number comes from the systems of
 * record or the anonymous discovery signals; nothing here identifies a person.
 */
export default function Analytics() {
  const [days, setDays] = useState(30);
  const [type, setType] = useState('');
  const o = useApi<Overview>(`/api/admin/v1/analytics/overview?days=${days}`);
  const liq = useApi<Liquidity>(
    `/api/admin/v1/analytics/liquidity?days=${days}${type ? `&type=${type}` : ''}`,
  );
  const aiUsage = useApi<AiUsage>(`/api/admin/v1/ai/usage?days=${days}`);
  const d = o.data;
  return (
    <div>
      <h1>Analytics</h1>
      <div className="filters">
        <label>
          Period
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last 365 days</option>
          </select>
        </label>
      </div>
      {o.error ? (
        <p className="error" role="alert">
          {o.error} <button onClick={() => void o.reload()}>Retry</button>
        </p>
      ) : !d ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <h2>Liquidity</h2>
          <Cards
            items={[
              ['Searches', d.demand.searches.total],
              [
                'Zero-result searches',
                pct(d.demand.searches.zeroResultRate),
                `${d.demand.searches.zeroResult} searches`,
              ],
              ['Search → booking', pct(d.demand.conversion.searchToBooking), 'confirmed bookings ÷ searches'],
              [
                'Booking success',
                pct(d.demand.bookings.successRate),
                `${d.demand.bookings.requested} requests`,
              ],
              ['Utilisation', pct(d.supply.utilisation), 'booked ÷ open unit-hours'],
            ]}
          />
          <div className="trends">
            <Trend
              label="Searches"
              values={d.daily.map((x) => ({ day: x.day, v: x.searches }))}
              format={String}
            />
            <Trend
              label="Zero-result searches"
              values={d.daily.map((x) => ({ day: x.day, v: x.zeroResultSearches }))}
              format={String}
            />
            <Trend
              label="Confirmed bookings"
              values={d.daily.map((x) => ({ day: x.day, v: x.confirmedBookings }))}
              format={String}
            />
            <Trend label="GMV" values={d.daily.map((x) => ({ day: x.day, v: x.gmvPaise }))} format={money} />
          </div>

          <h2>Marketplace</h2>
          <Cards
            items={[
              ['GMV', money(d.marketplace.gmvPaise), `net of refunds ${money(d.marketplace.netGmvPaise)}`],
              [
                'Platform revenue',
                money(d.marketplace.platformRevenuePaise),
                `commission ${money(d.marketplace.commissionPaise)} · fees ${money(d.marketplace.serviceFeePaise)}`,
              ],
              ['Average booking value', money(d.marketplace.averageBookingValuePaise)],
              [
                'Cancellation rate',
                pct(d.marketplace.cancellation.rate),
                `customer ${d.marketplace.cancellation.byCustomer} · host ${d.marketplace.cancellation.byHost} · platform ${d.marketplace.cancellation.byPlatform}`,
              ],
              ['No-show rate', pct(d.marketplace.noShowRate)],
              ['Host retention', pct(d.marketplace.retention.hosts), 'booked last period and this one'],
              [
                'Customer retention',
                pct(d.marketplace.retention.customers),
                'booked last period and this one',
              ],
            ]}
          />

          <h2>Supply</h2>
          <Cards
            items={[
              ['Hosts', d.supply.hosts.total, `${d.supply.hosts.new} new`],
              ['Hosts live', d.supply.hosts.live, 'with a published listing'],
              ['Hosts with bookings', d.supply.hosts.withBookings],
            ]}
          />
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Published listings</th>
                <th>Active units</th>
                <th>Open unit-hours</th>
                <th>Booked unit-hours</th>
                <th>Utilisation</th>
              </tr>
            </thead>
            <tbody>
              {d.supply.byType.map((t) => (
                <tr key={t.assetType}>
                  <td>{TYPE[t.assetType] ?? t.assetType}</td>
                  <td>{t.publishedListings}</td>
                  <td>{t.activeUnits}</td>
                  <td>{t.openUnitHours}</td>
                  <td>{t.bookedUnitHours}</td>
                  <td>{pct(t.utilisation)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Demand</h2>
          <Cards
            items={[
              ['Customers', d.demand.customers.total, `${d.demand.customers.new} new`],
              ['Customers who booked', d.demand.customers.withBookings],
              [
                'Repeat customers',
                d.demand.repeatCustomers,
                `${pct(d.demand.repeatRate)} of those who booked`,
              ],
              [
                'Listing views',
                d.demand.listingViews,
                `view → booking ${pct(d.demand.conversion.viewToBooking)}`,
              ],
              ['Searches with times', d.demand.searches.withTimeWindow],
            ]}
          />
        </>
      )}

      <h2>Liquidity by area</h2>
      <p className="small muted">
        ≈1 km cells, most zero-result searches first: where customers look and find nothing is where to
        recruit hosts.
      </p>
      <div className="filters">
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            <option value="PARKING">Parking</option>
            <option value="EV_CHARGING">EV charging</option>
          </select>
        </label>
      </div>
      {liq.error ? (
        <p className="error" role="alert">
          {liq.error} <button onClick={() => void liq.reload()}>Retry</button>
        </p>
      ) : !liq.data ? (
        <p className="muted">Loading…</p>
      ) : liq.data.areas.length === 0 ? (
        <p className="muted">No searches or listings in this period.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Area</th>
              <th>Cell</th>
              <th>Searches</th>
              <th>Zero-result</th>
              <th>Published listings</th>
              <th>Confirmed bookings</th>
            </tr>
          </thead>
          <tbody>
            {liq.data.areas.map((a) => (
              <tr key={a.cell}>
                <td>{a.areaLabel ?? <span className="muted">Unknown (no supply)</span>}</td>
                <td className="small">{a.cell}</td>
                <td>{a.searches}</td>
                <td className={a.zeroResultRate != null && a.zeroResultRate >= 0.5 ? 'error' : undefined}>
                  {a.zeroResultSearches} ({pct(a.zeroResultRate)})
                </td>
                <td>{a.publishedListings}</td>
                <td>{a.confirmedBookings}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>AI</h2>
      {aiUsage.error ? (
        <p className="error" role="alert">
          {aiUsage.error} <button onClick={() => void aiUsage.reload()}>Retry</button>
        </p>
      ) : !aiUsage.data ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p className="small muted">
            {aiUsage.data.configured
              ? `Model: ${aiUsage.data.configured.provider} ${aiUsage.data.configured.model}.`
              : 'No model configured: natural-language search uses the rules parser.'}{' '}
            Spent today ${aiUsage.data.spentTodayUsd.toFixed(4)} of ${aiUsage.data.dailyBudgetUsd} budget.
          </p>
          {aiUsage.data.rows.length === 0 ? (
            <p className="muted">No AI requests in this period.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Provider / model</th>
                  <th>Calls</th>
                  <th>Model answers</th>
                  <th>Fallbacks</th>
                  <th>Latency p50 / p95</th>
                  <th>Tokens in / out</th>
                  <th>Cost</th>
                  <th>Tool calls</th>
                  <th>Fields understood</th>
                  <th>Feedback</th>
                </tr>
              </thead>
              <tbody>
                {aiUsage.data.rows.map((r) => (
                  <tr key={`${r.feature}-${r.provider}-${r.model ?? ''}`}>
                    <td>{r.feature === 'SEARCH_INTENT' ? 'Natural-language search' : r.feature}</td>
                    <td>
                      {r.provider}
                      {r.model ? ` / ${r.model}` : ''}
                    </td>
                    <td>{r.calls}</td>
                    <td>{r.modelAnswers}</td>
                    <td className="small">
                      {[
                        ['no model', r.fallbacks.noProvider],
                        ['budget', r.fallbacks.budget],
                        ['timeout', r.fallbacks.timeout],
                        ['error', r.fallbacks.error],
                        ['invalid output', r.fallbacks.invalidOutput],
                      ]
                        .filter(([, v]) => Number(v) > 0)
                        .map(([k, v]) => `${k} ${v}`)
                        .join(' · ') || '—'}
                    </td>
                    <td>
                      {r.latencyMs.p50 ?? '—'} / {r.latencyMs.p95 ?? '—'} ms
                    </td>
                    <td>
                      {r.tokens.input} / {r.tokens.output}
                    </td>
                    <td>${r.costUsd.toFixed(4)}</td>
                    <td>{r.toolCalls}</td>
                    <td>
                      {r.averageFieldsUnderstood ?? '—'} avg · {r.nothingUnderstood} none
                    </td>
                    <td>
                      helpful {r.feedback.helpful} · not {r.feedback.notHelpful}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
