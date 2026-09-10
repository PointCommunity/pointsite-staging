import { SiteRenderer } from '@/site-kit/SiteRenderer';
import { migrateDocument } from '@/site-kit/migrations';
import rawDocument from '@/content/builder-site.json';
import { basePath } from '@/lib/paths';

const parsed = migrateDocument(rawDocument).document;

export const builderDocument = {
  ...parsed,
  media: parsed.media.map((item) => ({ ...item, sourcePath: `${basePath}${item.sourcePath}` })),
};

export function BuilderSite({ route }: { route: string }) {
  return <SiteRenderer document={builderDocument} route={route} />;
}
