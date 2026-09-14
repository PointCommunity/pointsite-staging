# PointSite Staging Safety

- This repository is an isolated staging target. Never push from this repository to the `production` remote.
- Builder candidate publication may update only `content/builder-site.json`, `content/builder-site.manifest.json`, `content/builder-site.output.json`, and the candidate's validated image paths under `public/assets/`. The output manifest records the complete static-file hashes needed for reproducible promotion and recovery.
- Runtime and workflow changes are maintainer changes reviewed under the parent Builder Issue, never files accepted from a publication request. A runner uploads candidate objects only to its job-owned `builder-publications/<job-id>` branch; Builder's fresh authority and expected-base checks control the update to `main`.
- A staging pass is not production approval. Production requires a separately reviewed exact candidate and explicit authorization.
- Keep the exported website static: no private builder API, session token, D1 binding, object credential, or GitHub credential may enter this bundle.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
