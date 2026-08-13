import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GMA Store POS',
  description: 'Fast, offline-first sari-sari store point of sale.',
  applicationName: 'GMA Store POS',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'GMA POS', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#f7f5ef',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
