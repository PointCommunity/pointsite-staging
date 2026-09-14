import type { Metadata } from 'next';
import { basePath } from '@/lib/paths';
import './globals.css';
import '@/site-kit/site.css';
import './staging-overrides.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://pointatx.org/'),
  title: {
    default: 'Point Community Church | South Austin',
    template: '%s | Point Community Church',
  },
  description:
    'A family of Jesus-followers in South Austin, empowered by the Holy Spirit to make disciples of Jesus in all of life for the glory of God.',
  openGraph: {
    title: 'Point Community Church',
    description:
      'A family of Jesus-followers in South Austin, empowered by the Holy Spirit to make disciples of Jesus.',
    type: 'website',
  },
  icons: { icon: `${basePath}/favicon.png` },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
