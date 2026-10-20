import Link from 'next/link';
import {
  ArrowRightIcon,
  BoltIcon,
  CalendarIcon,
  CarIcon,
  CheckIcon,
  KeyIcon,
  PinIcon,
  SearchIcon,
  ShieldIcon,
  WalletIcon,
} from '../components/icons';

const STEPS = [
  {
    Icon: SearchIcon,
    title: 'Search',
    text: 'Tell us where and when. We show spots near you, with real availability.',
  },
  {
    Icon: CalendarIcon,
    title: 'Book and pay',
    text: 'See the full price before you pay. Your spot is held while you check out.',
  },
  {
    Icon: KeyIcon,
    title: 'Get in',
    text: 'Your access code or pass appears when your booking starts. Park and go.',
  },
] as const;

const TRUST = [
  {
    Icon: ShieldIcon,
    title: 'Every host checked',
    text: 'Every listing is reviewed by our team before it goes live.',
  },
  {
    Icon: PinIcon,
    title: 'Private until you book',
    text: 'Exact addresses are shared only with confirmed bookings.',
  },
  {
    Icon: CheckIcon,
    title: 'Help within 15 minutes',
    text: "Can't get in? The host has 15 minutes to fix it, or you get a full refund.",
  },
] as const;

/** Landing (ux-architecture C-01): what ParkBro is, for drivers, EV owners and hosts, with one clear action. */
export default function HomePage() {
  return (
    <main className="landing">
      <section className="hero">
        <div className="hero-inner">
          <p className="eyebrow">
            <span className="dot" aria-hidden="true" /> Now in Bengaluru
          </p>
          <h1>
            Park or charge, <span className="gradient-text">guaranteed</span>, right where you&apos;re going.
          </h1>
          <p className="lead">
            Book private driveways, society spaces and home EV chargers by the hour, day, night or month. No
            circling the block.
          </p>
          <div className="hero-actions">
            <Link href="/search" className="button large">
              Search near you
            </Link>
            <Link href="/host/listings/new" className="button ghost large">
              List your space
            </Link>
          </div>
          <ul className="hero-points" aria-label="Highlights">
            <li>
              <CarIcon size={18} /> Hourly, daily, overnight and monthly
            </li>
            <li>
              <BoltIcon size={18} /> Home and commercial EV chargers
            </li>
            <li>
              <WalletIcon size={18} /> Pay securely, see the full price first
            </li>
          </ul>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-card art-card-1">
            <span className="art-icon">
              <CarIcon size={22} />
            </span>
            <div>
              <strong>Covered driveway</strong>
              <span>Koramangala · 350 m</span>
            </div>
            <em>₹40/h</em>
          </div>
          <div className="art-card art-card-2">
            <span className="art-icon ev">
              <BoltIcon size={22} />
            </span>
            <div>
              <strong>Type 2 charger · 7.4 kW</strong>
              <span>HSR Layout · 1.2 km</span>
            </div>
            <em>₹120/h</em>
          </div>
          <div className="art-card art-card-3">
            <span className="art-icon ok">
              <CheckIcon size={22} />
            </span>
            <div>
              <strong>Booking confirmed</strong>
              <span>Your code: 4 8 2 9 1 6</span>
            </div>
          </div>
        </div>
      </section>

      <section className="band" aria-labelledby="how">
        <div className="band-inner">
          <h2 id="how">How it works</h2>
          <ol className="steps">
            {STEPS.map(({ Icon, title, text }, i) => (
              <li key={title} className="step">
                <span className="step-icon">
                  <Icon size={22} />
                </span>
                <span className="step-number">{i + 1}</span>
                <h3>{title}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="band" aria-labelledby="audiences">
        <div className="band-inner">
          <h2 id="audiences" className="visually-hidden">
            For drivers, EV owners and hosts
          </h2>
          <div className="feature-grid">
            <article className="feature">
              <span className="feature-icon">
                <CarIcon size={24} />
              </span>
              <h3>For drivers</h3>
              <p>
                Office days, airport runs, a night out or a monthly spot near home, booked in under a minute.
              </p>
              <Link href="/search" className="text-link">
                Find parking <ArrowRightIcon size={16} />
              </Link>
            </article>
            <article className="feature ev">
              <span className="feature-icon">
                <BoltIcon size={24} />
              </span>
              <h3>For EV owners</h3>
              <p>Filter by connector, AC or DC and power. Parking is included while you charge.</p>
              <Link href="/search" className="text-link">
                Find a charger <ArrowRightIcon size={16} />
              </Link>
            </article>
            <article className="feature host">
              <span className="feature-icon">
                <WalletIcon size={24} />
              </span>
              <h3>For hosts</h3>
              <p>
                Earn from an empty driveway or charger. You set the hours and prices, and approve if you like.
              </p>
              <Link href="/host/listings/new" className="text-link">
                Start hosting <ArrowRightIcon size={16} />
              </Link>
            </article>
          </div>
        </div>
      </section>

      <section className="band" aria-labelledby="trust">
        <div className="band-inner">
          <h2 id="trust">Built on trust</h2>
          <ul className="trust-grid">
            {TRUST.map(({ Icon, title, text }) => (
              <li key={title}>
                <span className="trust-icon">
                  <Icon size={20} />
                </span>
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="band">
        <div className="band-inner">
          <div className="cta">
            <div>
              <h2>Ready when you are</h2>
              <p>Sign in with your mobile number. No passwords.</p>
            </div>
            <div className="hero-actions">
              <Link href="/sign-in" className="button large light">
                Sign in or create an account
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
