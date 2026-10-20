import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Privacy notice' };

// Pilot draft (notice version pilot-2026-10). Final text requires legal review before launch (PROJECT_STATUS blockers).
export default function Page() {
  return (
    <main className="page medium prose">
      <h1>Privacy notice</h1>
      <p className="notice">
        Pilot draft, under legal review. This text will be replaced before public launch.
      </p>
      <p>
        We collect your mobile number to sign you in, your name to show hosts who is arriving, and, when you
        book, your vehicle registration so the gate can let you in. We use this data only to run bookings,
        keep the platform safe and meet legal obligations. We never sell it.
      </p>
      <p>
        Your mobile number is stored encrypted. Hosts never see it; calls go through a masked number. Exact
        addresses of homes are shown only to customers with a confirmed booking. You can see and correct your
        data in your account, and ask us to delete it.
      </p>
    </main>
  );
}
