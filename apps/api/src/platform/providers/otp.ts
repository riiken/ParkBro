/**
 * OTP delivery (architecture.md §5 OtpProvider). The platform generates and verifies codes; providers only
 * deliver them. Production needs a TRAI DLT-registered SMS / WhatsApp sender (Phase 18, R-46): until then
 * the API refuses to start in production (env validation).
 */
export interface OtpMessage {
  phoneE164: string;
  code: string;
  purpose: 'USER_LOGIN' | 'ADMIN_LOGIN';
  expiresInMinutes: number;
}

export interface OtpSender {
  readonly name: string;
  send(message: OtpMessage): Promise<void>;
}

/** Development only: prints the code to the API's stderr (never to the structured log). */
export function consoleOtpSender(): OtpSender {
  return {
    name: 'console',
    async send({ phoneE164, code, purpose }) {
      process.stderr.write(`[dev otp] ${purpose} for ••••${phoneE164.slice(-4)}: ${code}\n`);
    },
  };
}

/** Tests: keeps the last code per phone in memory. */
export function memoryOtpSender(): OtpSender & {
  lastCode(phoneE164: string): string | undefined;
  sent: OtpMessage[];
} {
  const sent: OtpMessage[] = [];
  return {
    name: 'memory',
    sent,
    async send(message) {
      sent.push(message);
    },
    lastCode(phoneE164) {
      return sent.filter((m) => m.phoneE164 === phoneE164).at(-1)?.code;
    },
  };
}

/** Never delivers anything. Used with the dev-fixed code generator (non-production e2e runs). */
export function noopOtpSender(): OtpSender {
  return { name: 'noop', async send() {} };
}
