# Point Community Church website

A complete, responsive, GitHub-owned replacement for the current Point ATX SnapPages site. It is statically generated, deployed by GitHub Actions, and organized so content, media, integrations, and presentation can be changed independently.

## Access model

The published website is intentionally read-only. It has no visitor-facing editor, admin panel, sign-in, database, content mutation API, or code-writing capability. Only collaborators with write access to the GitHub repository can change the site, and every published change is traceable to a commit and deployment.

This staging repository adds a Worker wrapper that denies anonymous requests and
validates the shared PointSite Builder GitHub session through the Builder before
serving static assets. A separate staging probe secret permits read-only CI
verification. The `workers.dev` route is enabled only as an authenticated CI
probe path because Bot Fight Mode challenges GitHub-hosted runners on the custom
domain; preview URLs remain disabled. Both hosts execute the same Worker access
gate before static assets are served.

## Everyday editing

The main editing surface is [`content/site.ts`](content/site.ts). It contains:

- church name, address, service time, email, social links, and giving URL;
- main navigation and dropdowns;
- every public page and route;
- beliefs, leaders, Neighborhood Groups, FAQs, calendar events, and form fields.

Images live in [`public/assets`](public/assets). Replace a file while keeping its filename to update it everywhere, or add a new file and change its path in `content/site.ts`.

Global colors, typography, spacing, and responsive layout live in [`app/globals.css`](app/globals.css). Shared site pieces live in [`components`](components), so a header, footer, form, calendar, or page pattern is updated once.

## Forms and integrations

GitHub Pages is static and cannot receive or store private form submissions. The default form adapter validates the fields and opens a visitor's email app with a reviewable message addressed to the church email in `content/site.ts`. This keeps submissions direct and avoids sending personal information through an unapproved third party.

The delivery behavior is isolated in [`components/ManagedForm.tsx`](components/ManagedForm.tsx). It can later be swapped for Planning Center, Subsplash, Formspree, a custom API, or another approved service without rebuilding the individual forms. Giving already hands off to the configured secure Subsplash URL.

## Calendar

The community calendar route is currently archived: it is absent from public navigation and static route generation, while its page definition, event data, form, renderer, and calendar component remain in the repository for easy restoration.

Add events to `calendarEvents` in `content/site.ts`:

```ts
{ date: '2026-09-13', title: 'Community Lunch', time: '12:00 PM' }
```

The calendar automatically places them in the correct month and supports previous/next month navigation.

## Local development

Requires Node.js 22 or newer.

```bash
npm ci
npm run dev
```

Use `npm run check` before pushing. A push to `main` automatically builds and publishes the site through GitHub Pages.

## Future custom domain or repository transfer

The Pages workflow automatically uses the repository name as its base path. When a custom domain is added, set the repository Actions variable `SITE_BASE_PATH` to `/` and add the domain to GitHub Pages. No page code needs to change.

## Optional future maintainer tool

The content is already separated from the renderer as typed, block-like data. A separate drag-and-drop maintainer tool could eventually read and update this schema, manage files under `public/assets`, and commit through GitHub's API. It would be restricted to authorized repository collaborators and would never be exposed as an editing surface on the public website. The shared components remain the design system, preventing page-by-page layout drift.
