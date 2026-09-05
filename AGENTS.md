# PointSite Staging Safety

- This repository is an isolated staging target. Never push from this repository to the `production` remote.
- Builder publication may update only `content/builder-site.json` and `content/builder-site.manifest.json`.
- A staging pass is not production approval. Production requires a separately reviewed exact candidate and explicit authorization.
- Keep the exported website static: no private builder API, Cloudflare Access assertion, D1 binding, R2 credential, or GitHub credential may enter this bundle.
