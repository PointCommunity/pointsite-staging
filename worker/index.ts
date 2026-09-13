interface StagingEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  BUILDER_ORIGIN: string;
  STAGING_PROBE_SECRET: string;
  CF_VERSION_METADATA?: { id: string };
}

function sessionCookie(request: Request): string | null {
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name === "__Secure-pointsite_builder_session") return value.join("=");
  }
  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index++)
    difference |=
      (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

function secured(response: Response): Response {
  const result = new Response(response.body, response);
  result.headers.set("cache-control", "private, no-store");
  result.headers.set("referrer-policy", "no-referrer");
  result.headers.set("x-content-type-options", "nosniff");
  result.headers.set("x-frame-options", "DENY");
  return result;
}

function signInResponse(builderOrigin: string): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PointSite Staging</title>
    <style>
      :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #101510; color: #f4f5f1; }
      main { width: min(30rem, calc(100% - 2rem)); border: 1px solid #3d4939; background: #192018; padding: 2rem; }
      p { color: #c5ccbf; line-height: 1.6; }
      a { display: inline-flex; min-height: 2.75rem; align-items: center; border: 2px solid #9bc574; background: #9bc574; color: #172015; padding: .65rem 1rem; font-weight: 800; text-decoration: none; }
      a:hover { background: #b2d88e; }
      a:focus-visible { outline: 3px solid #f4f5f1; outline-offset: 3px; }
    </style>
  </head>
  <body>
    <main>
      <h1>PointSite staging is protected</h1>
      <p>Sign in through PointSite Builder to preview staging.</p>
      <a href="${builderOrigin}">Open PointSite Builder</a>
    </main>
  </body>
</html>`;
  const response = secured(
    new Response(html, {
      status: 401,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  );
  response.headers.set(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  return response;
}

export async function authorizeStagingRequest(
  request: Request,
  env: StagingEnv,
  fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  if (
    typeof env.STAGING_PROBE_SECRET !== "string" ||
    env.STAGING_PROBE_SECRET.length < 32 ||
    env.BUILDER_ORIGIN !== "https://builder.pointatx.org"
  )
    return secured(
      new Response("Staging authentication is not configured", { status: 503 }),
    );

  const probe = request.headers.get("X-PointSite-Staging-Probe") ?? "";
  if (probe && constantTimeEqual(probe, env.STAGING_PROBE_SECRET)) return null;

  const session = sessionCookie(request);
  if (!session) return signInResponse(env.BUILDER_ORIGIN);
  const identity = await fetcher(`${env.BUILDER_ORIGIN}/api/me`, {
    headers: { cookie: `__Secure-pointsite_builder_session=${session}` },
    redirect: "manual",
  });
  if (!identity.ok)
    return secured(
      new Response("Staging access denied", {
        status: identity.status === 403 ? 403 : 401,
      }),
    );
  return null;
}

const worker = {
  async fetch(request: Request, env: StagingEnv): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "GET" &&
      url.pathname === "/__pointsite_release.json" &&
      !url.search
    ) {
      try {
        const version = env.CF_VERSION_METADATA?.id;
        if (
          !version ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            version,
          )
        )
          throw new Error("Missing native version");
        // This endpoint exposes only four content-free release fields and the native
        // Worker version. Never forward a session, probe header or arbitrary asset path.
        const response = await env.ASSETS.fetch(
          new Request(url, { headers: { accept: "application/json" } }),
        );
        if (!response.ok || !response.body)
          throw new Error("Missing release identity");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 1024) throw new Error("Oversized release identity");
            chunks.push(value);
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Invalid identity");
        const release = value as Record<string, unknown>;
        if (
          Object.keys(release).length !== 4 ||
          release.format !== 2 ||
          typeof release.candidateChecksum !== "string" ||
          !/^[a-f0-9]{64}$/.test(release.candidateChecksum) ||
          typeof release.artifactDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(release.artifactDigest) ||
          typeof release.workflowRevision !== "string" ||
          !/^[a-f0-9]{40}$/.test(release.workflowRevision)
        )
          throw new Error("Invalid identity");
        return secured(Response.json({ ...release, workerVersionId: version }));
      } catch {
        return secured(
          Response.json(
            { error: "Release identity unavailable" },
            { status: 503 },
          ),
        );
      }
    }
    const denied = await authorizeStagingRequest(request, env);
    if (denied) return denied;
    return secured(await env.ASSETS.fetch(request));
  },
};

export default worker;
