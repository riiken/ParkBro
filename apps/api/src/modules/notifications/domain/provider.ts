import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Messaging provider seam (architecture §5 "MessagingProvider"). Real adapters (a WhatsApp BSP, a DLT-registered SMS
 * gateway, a transactional email service, Web Push with VAPID) are configured when the owner registers them (R-46).
 * `idempotencyKey` is our notification id: providers that support it deduplicate retries.
 */
export type ExternalChannel = 'SMS' | 'WHATSAPP' | 'EMAIL' | 'PUSH';

export class PermanentDeliveryError extends Error {}

export interface OutgoingMessage {
  channel: ExternalChannel;
  to: string;
  template: string;
  text: string;
  idempotencyKey: string;
}

export interface MessagingProvider {
  readonly name: string;
  readonly channels: readonly ExternalChannel[];
  send(message: OutgoingMessage): Promise<{ messageId: string }>;
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(rawBody: string): { messageId: string; status: 'DELIVERED' | 'FAILED'; error?: string }[];
}

const sigHeader = (h: Record<string, string | string[] | undefined>) => {
  const v = h['x-msg-signature'];
  return Array.isArray(v) ? v[0] : v;
};

/** Development: prints a redacted line (never the full number) instead of sending. */
export function consoleMessaging(
  log: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): MessagingProvider {
  let n = 0;
  return {
    name: 'console',
    channels: ['SMS', 'WHATSAPP'],
    async send(m) {
      n += 1;
      log(`[messaging:${m.channel}] to ••••${m.to.slice(-4)} · ${m.template} · ${m.text}`);
      return { messageId: `console-${n}-${m.idempotencyKey}` };
    },
    verifyWebhook: () => false,
    parseWebhook: () => [],
  };
}

export const MEMORY_WEBHOOK_SECRET = 'memory-messaging-secret-for-tests';

/** Tests: records messages, can fail on demand, and produces signed delivery webhooks. */
export function memoryMessaging() {
  const sent: (OutgoingMessage & { messageId: string })[] = [];
  const failures: ('transient' | 'permanent')[] = [];
  const sign = (body: string) => createHmac('sha256', MEMORY_WEBHOOK_SECRET).update(body).digest('hex');
  const provider: MessagingProvider & {
    sent: typeof sent;
    failNext: (kind: 'transient' | 'permanent', times?: number) => void;
    clearFailures: () => void;
    deliveryWebhook: (
      messageId: string,
      status: 'DELIVERED' | 'FAILED',
    ) => { rawBody: string; headers: Record<string, string> };
  } = {
    name: 'memory',
    channels: ['SMS', 'WHATSAPP', 'EMAIL', 'PUSH'],
    sent,
    failNext(kind, times = 1) {
      for (let i = 0; i < times; i += 1) failures.push(kind);
    },
    clearFailures() {
      failures.length = 0;
    },
    async send(m) {
      const f = failures.shift();
      if (f === 'permanent') throw new PermanentDeliveryError('invalid recipient');
      if (f === 'transient') throw new Error('provider timeout');
      // Idempotent by our key, like a real provider with idempotency support.
      const existing = sent.find((s) => s.idempotencyKey === m.idempotencyKey);
      if (existing) return { messageId: existing.messageId };
      const messageId = `mem-${sent.length + 1}`;
      sent.push({ ...m, messageId });
      return { messageId };
    },
    verifyWebhook(rawBody, headers) {
      const s = sigHeader(headers);
      if (!s) return false;
      const a = Buffer.from(sign(rawBody));
      const b = Buffer.from(s);
      return a.length === b.length && timingSafeEqual(a, b);
    },
    parseWebhook(rawBody) {
      return (
        JSON.parse(rawBody) as {
          statuses: { messageId: string; status: 'DELIVERED' | 'FAILED'; error?: string }[];
        }
      ).statuses;
    },
    deliveryWebhook(messageId, status) {
      const rawBody = JSON.stringify({ statuses: [{ messageId, status }] });
      return { rawBody, headers: { 'x-msg-signature': sign(rawBody), 'content-type': 'application/json' } };
    },
  };
  return provider;
}
