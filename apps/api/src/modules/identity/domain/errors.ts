import { DomainError } from '../../../platform/errors/domain-error.ts';

export const identityErrors = {
  inviteOnly: () =>
    new DomainError({
      code: 'auth.invite_only',
      status: 403,
      title: 'This test environment is invite-only',
      detail: 'Ask the ParkBro team to add your number.',
    }),
  phoneInvalid: () =>
    new DomainError({
      code: 'auth.phone_invalid',
      status: 400,
      title: 'Enter a valid Indian mobile number',
      detail: 'Use a 10-digit mobile number, e.g. 98765 43210.',
    }),
  otpExpired: () =>
    new DomainError({
      code: 'auth.otp_expired',
      status: 400,
      title: 'This code is no longer valid',
      detail: 'Request a new code and try again.',
    }),
  otpIncorrect: (attemptsRemaining: number) =>
    new DomainError({
      code: 'auth.otp_incorrect',
      status: 400,
      title: 'That code is incorrect',
      detail:
        attemptsRemaining > 0
          ? `${attemptsRemaining} attempt${attemptsRemaining === 1 ? '' : 's'} left.`
          : 'Too many attempts. Request a new code.',
    }),
  ticketInvalid: () =>
    new DomainError({
      code: 'auth.ticket_invalid',
      status: 400,
      title: 'Your sign-in step expired',
      detail: 'Start again by requesting a new code.',
    }),
  noticeVersionMismatch: () =>
    new DomainError({
      code: 'auth.notice_outdated',
      status: 400,
      title: 'Our terms have been updated',
      detail: 'Please review and accept the latest terms.',
    }),
  accountSuspended: () =>
    new DomainError({
      code: 'auth.account_suspended',
      status: 403,
      title: 'This account is suspended',
      detail: 'Contact support for help.',
    }),
  notAdmin: () => new DomainError({ code: 'auth.not_admin', status: 403, title: 'Not allowed' }),
  totpIncorrect: () =>
    new DomainError({
      code: 'auth.totp_incorrect',
      status: 400,
      title: 'That authenticator code is incorrect',
    }),
  deliveryFailed: () =>
    new DomainError({
      code: 'auth.otp_delivery_failed',
      status: 503,
      title: "We couldn't send your code",
      detail: 'Please try again in a moment.',
    }),
};
