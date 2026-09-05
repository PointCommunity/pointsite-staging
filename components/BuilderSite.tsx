import { SiteRenderer } from '@/site-kit/SiteRenderer';
import { SiteDocumentSchema } from '@/site-kit/schema';
import rawDocument from '@/content/builder-site.json';
import { basePath } from '@/lib/paths';

const parsed = SiteDocumentSchema.parse(rawDocument);

export const builderDocument = {
  ...parsed,
  media: parsed.media.map((item) => ({ ...item, sourcePath: `${basePath}${item.sourcePath}` })),
};

export function BuilderSite({ route }: { route: string }) {
  return <SiteRenderer document={builderDocument} route={route} />;
}
