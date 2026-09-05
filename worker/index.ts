interface StagingEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  BUILDER_ORIGIN: string;
  STAGING_PROBE_SECRET: string;
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
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
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
    return secured(new Response("Staging authentication is not configured", { status: 503 }));

  const probe = request.headers.get("X-PointSite-Staging-Probe") ?? "";
  if (probe && constantTimeEqual(probe, env.STAGING_PROBE_SECRET)) return null;

  const session = sessionCookie(request);
  if (!session)
    return secured(new Response("Sign in through PointSite Builder", { status: 401 }));
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
    const denied = await authorizeStagingRequest(request, env);
    if (denied) return denied;
    return secured(await env.ASSETS.fetch(request));
  },
};

export default worker;
