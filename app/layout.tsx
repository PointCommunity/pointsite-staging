import type { Metadata } from 'next';
import { Lato, Libre_Baskerville } from 'next/font/google';
import { basePath } from '@/lib/paths';
import './globals.css';
import '@/site-kit/site.css';

const lato = Lato({
  variable: '--font-sans',
  subsets: ['latin'],
  weight: ['300', '400', '700', '900'],
});

const libre = Libre_Baskerville({
  variable: '--font-serif',
  subsets: ['latin'],
  weight: ['400', '700'],
});

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
      <body className={`${lato.variable} ${libre.variable}`}>
        {children}
      </body>
    </html>
  );
}
