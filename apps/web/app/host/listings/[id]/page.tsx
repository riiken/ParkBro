import type { Metadata } from 'next';
import { ListingEditor } from './listing-editor';

export const metadata: Metadata = { title: 'Edit listing' };

export default async function EditListingPage({ params }: { params: Promise<{ id: string }> }) {
  return <ListingEditor id={(await params).id} />;
}
