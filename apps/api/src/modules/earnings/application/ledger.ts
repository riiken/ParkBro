import { sql, type Kysely } from 'kysely';
import type { AnyKyselyExecutor } from '../../../platform/audit/audit-log.ts';
import { uuidv7 } from '../../../platform/ids/uuid.ts';
import type { EarningsDb } from '../infrastructure/tables.ts';

export type AccountCode =
  | 'CUSTOMER_CLEARING'
  | 'PLATFORM_SERVICE_FEE'
  | 'PLATFORM_COMMISSION'
  | 'TAX_PAYABLE'
  | 'HOST_PENDING'
  | 'HOST_AVAILABLE'
  | 'HOST_IN_PAYOUT'
  | 'HOST_RECEIVABLE'
  | 'PAYOUT_CASH';
export type JournalKind =
  | 'PAYMENT_CAPTURED'
  | 'REFUND'
  | 'EARNINGS_RELEASED'
  | 'PAYOUT_CREATED'
  | 'PAYOUT_PAID'
  | 'PAYOUT_FAILED'
  | 'RECEIVABLE_OFFSET';

const HOST_CODES = new Set<AccountCode>([
  'HOST_PENDING',
  'HOST_AVAILABLE',
  'HOST_IN_PAYOUT',
  'HOST_RECEIVABLE',
]);
export interface Line {
  account: AccountCode;
  hostAccountId?: string;
  direction: 'DEBIT' | 'CREDIT';
  amountPaise: number;
}

/**
 * Double-entry ledger (database-design §8). Journals are idempotent by key; every journal balances (the database
 * checks it at commit) and entries can never be changed. Zero lines are dropped.
 */
export function createLedger(db: Kysely<EarningsDb>) {
  const x = (executor?: AnyKyselyExecutor) => (executor as unknown as Kysely<EarningsDb> | undefined) ?? db;

  async function accountId(
    executor: AnyKyselyExecutor | undefined,
    code: AccountCode,
    hostAccountId?: string,
  ): Promise<string> {
    const ownerKind = HOST_CODES.has(code) ? 'HOST' : 'PLATFORM';
    const ownerId = ownerKind === 'HOST' ? (hostAccountId ?? null) : null;
    if (ownerKind === 'HOST' && !ownerId) throw new Error(`host account required for ${code}`);
    await x(executor)
      .insertInto('ledger.accounts')
      .values({ id: uuidv7(), code, owner_kind: ownerKind, owner_id: ownerId })
      .onConflict((oc) => oc.columns(['code', 'owner_kind', 'owner_id']).doNothing())
      .execute();
    const row = await x(executor)
      .selectFrom('ledger.accounts')
      .select('id')
      .where('code', '=', code)
      .where('owner_kind', '=', ownerKind)
      .where(ownerId ? sql<boolean>`owner_id = ${ownerId}` : sql<boolean>`owner_id IS NULL`)
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Posts a journal once per key; returns false if it already existed. */
  async function post(
    executor: AnyKyselyExecutor | undefined,
    journal: {
      kind: JournalKind;
      key: string;
      bookingId?: string;
      paymentId?: string;
      refundId?: string;
      payoutId?: string;
      hostAccountId?: string;
      memo?: string;
    },
    lines: Line[],
  ): Promise<boolean> {
    const real = lines.filter((l) => l.amountPaise > 0);
    if (real.length === 0) return false;
    const debit = real.filter((l) => l.direction === 'DEBIT').reduce((a, l) => a + l.amountPaise, 0);
    const credit = real.filter((l) => l.direction === 'CREDIT').reduce((a, l) => a + l.amountPaise, 0);
    if (debit !== credit) throw new Error(`unbalanced journal ${journal.key}: ${debit} ≠ ${credit}`);
    const id = uuidv7();
    const inserted = await x(executor)
      .insertInto('ledger.journals')
      .values({
        id,
        kind: journal.kind,
        idempotency_key: journal.key,
        booking_id: journal.bookingId ?? null,
        payment_id: journal.paymentId ?? null,
        refund_id: journal.refundId ?? null,
        payout_id: journal.payoutId ?? null,
        host_account_id: journal.hostAccountId ?? null,
        memo: journal.memo ?? null,
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) return false;
    for (const l of real) {
      await x(executor)
        .insertInto('ledger.entries')
        .values({
          journal_id: id,
          account_id: await accountId(executor, l.account, l.hostAccountId),
          direction: l.direction,
          amount_paise: l.amountPaise,
        })
        .execute();
    }
    return true;
  }

  /**
   * Balance in the account's natural direction: credit − debit for liabilities and revenue, debit − credit for
   * assets (clearing, receivable). Optionally only entries of journals for one booking.
   */
  async function balance(
    executor: AnyKyselyExecutor | undefined,
    code: AccountCode,
    hostAccountId?: string,
    bookingId?: string,
  ): Promise<number> {
    const asset = code === 'CUSTOMER_CLEARING' || code === 'HOST_RECEIVABLE';
    let q = x(executor)
      .selectFrom('ledger.entries as e')
      .innerJoin('ledger.accounts as a', 'a.id', 'e.account_id')
      .innerJoin('ledger.journals as j', 'j.id', 'e.journal_id')
      .select(
        sql<string>`coalesce(sum(CASE e.direction WHEN 'CREDIT' THEN e.amount_paise ELSE -e.amount_paise END), 0)`.as(
          'net',
        ),
      )
      .where('a.code', '=', code);
    if (hostAccountId) q = q.where('a.owner_id', '=', hostAccountId);
    if (bookingId) q = q.where('j.booking_id', '=', bookingId);
    const net = Number((await q.executeTakeFirstOrThrow()).net);
    return asset ? -net : net;
  }

  /** Σ debits = Σ credits over the whole ledger, per code (admin trial balance). */
  async function trialBalance() {
    const rows = await db
      .selectFrom('ledger.entries as e')
      .innerJoin('ledger.accounts as a', 'a.id', 'e.account_id')
      .select([
        'a.code',
        sql<string>`sum(CASE e.direction WHEN 'DEBIT' THEN e.amount_paise ELSE 0 END)`.as('debit'),
        sql<string>`sum(CASE e.direction WHEN 'CREDIT' THEN e.amount_paise ELSE 0 END)`.as('credit'),
      ])
      .groupBy('a.code')
      .orderBy('a.code')
      .execute();
    const accounts = rows.map((r) => ({
      code: r.code as AccountCode,
      debitPaise: Number(r.debit),
      creditPaise: Number(r.credit),
    }));
    const debit = accounts.reduce((a, r) => a + r.debitPaise, 0);
    const credit = accounts.reduce((a, r) => a + r.creditPaise, 0);
    return { accounts, debitPaise: debit, creditPaise: credit, balanced: debit === credit };
  }

  return { post, balance, trialBalance, accountId };
}

export type Ledger = ReturnType<typeof createLedger>;
