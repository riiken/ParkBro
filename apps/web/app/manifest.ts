import type { MetadataRoute } from 'next';

// PWA manifest (D-020). Name is the working name until the brand decision (UX-2).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ParkBro',
    short_name: 'ParkBro',
    description: 'Private parking and EV charging near you.',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}
