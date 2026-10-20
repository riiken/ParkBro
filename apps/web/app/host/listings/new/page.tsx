import type { Metadata } from 'next';
import { NewListing } from './new-listing';

export const metadata: Metadata = { title: 'New listing' };

export default function NewListingPage() {
  return <NewListing />;
}
