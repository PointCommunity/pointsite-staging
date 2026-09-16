import { z } from "zod";

/** Both Builder environments execute this same runtime with fixed, disjoint destinations. */
export function publicationDestination(
  target: "staging" | "production",
  builderOrigin = process.env.BUILDER_ORIGIN ?? "https://builder.eaglepass.io",
) {
  z.enum(["staging", "production"]).parse(target);
  z.enum(["https://builder.eaglepass.io", "https://builder-canary.eaglepass.io"]).parse(builderOrigin);
  const canary = builderOrigin === "https://builder-canary.eaglepass.io";
  const destination = target === "production"
    ? canary
      ? { repository: "pointsite-canary", origin: "https://canary.pointatx.org" }
      : { repository: "pointsite", origin: "https://pointatx.org" }
    : canary
      ? { repository: "pointsite-staging-canary", origin: "https://staging-canary.pointatx.org" }
      : { repository: "pointsite-staging", origin: "https://staging.pointatx.org" };
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REPOSITORY !== `PointCommunity/${destination.repository}`)
    throw new Error("PUBLICATION_DESTINATION_REJECTED");
  return destination;
}
