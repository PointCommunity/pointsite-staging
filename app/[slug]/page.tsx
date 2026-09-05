import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BuilderSite, builderDocument } from '@/components/BuilderSite';

export function generateStaticParams() {
  return builderDocument.pages.filter((page) => page.route !== '/').map((page) => ({ slug: page.route.slice(1) }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const page = builderDocument.pages.find((candidate) => candidate.route === `/${slug}`);
  if (!page) return {};
  return { title: page.metadata.title, description: page.metadata.description };
}

export default async function ContentRoute({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = builderDocument.pages.find((candidate) => candidate.route === `/${slug}`);
  if (!page) notFound();

  return <BuilderSite route={page.route} />;
}
