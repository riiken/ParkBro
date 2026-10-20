import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms of use' };

// Pilot draft (notice version pilot-2026-10). Final text requires legal review before launch (PROJECT_STATUS blockers).
export default function Page() {
  return (
    <main className="page medium prose">
      <h1>Terms of use</h1>
      <p className="notice">
        Pilot draft, under legal review. This text will be replaced before public launch.
      </p>
      <p>
        ParkBro is a marketplace that connects people who need parking or EV charging with hosts who have
        unused spaces. Hosts are responsible for the accuracy of their listings and their right to rent them;
        customers are responsible for their vehicles and conduct. You must be 18 or older to use the service.
      </p>
      <p>
        If you cannot get in to a booked space and the host cannot fix it in time, we refund you in full.
        ParkBro is not an insurer: damage claims are handled through our dispute process.
      </p>
    </main>
  );
}
