import type { Metadata } from 'next';
import { SignInFlow } from './sign-in-flow';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="page narrow">
      <SignInFlow next={next ?? null} />
    </main>
  );
}
