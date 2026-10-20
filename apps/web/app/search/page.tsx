import type { Metadata } from 'next';
import { SearchView } from './search-view';

export const metadata: Metadata = { title: 'Find parking or EV charging' };

export default function SearchPage() {
  return (
    <main className="page wide">
      <SearchView />
    </main>
  );
}
