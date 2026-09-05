# PointSite Staging Safety

- This repository is an isolated staging target. Never push from this repository to the `production` remote.
- Builder publication may update only `content/builder-site.json` and `content/builder-site.manifest.json`.
- A staging pass is not production approval. Production requires a separately reviewed exact candidate and explicit authorization.
- Keep the exported website static: no private builder API, Cloudflare Access assertion, D1 binding, R2 credential, or GitHub credential may enter this bundle.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
