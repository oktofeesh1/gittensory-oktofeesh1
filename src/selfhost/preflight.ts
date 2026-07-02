import { createPrivateKey } from "node:crypto";

export type SelfHostPreflightProblem = {
  var: string;
  message: string;
};

export type SelfHostPreflightResult =
  | { ok: true; problems: [] }
  | { ok: false; problems: SelfHostPreflightProblem[] };

type SelfHostPreflightEnv = Record<string, string | undefined>;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isBareHttpsOrigin(value: string): boolean {
  const url = parsedUrl(value);
  return (
    url !== null &&
    url.protocol === "https:" &&
    url.hostname.length > 0 &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === ""
  );
}

function isRedisUrl(value: string): boolean {
  const url = parsedUrl(value);
  return (
    url !== null &&
    (url.protocol === "redis:" || url.protocol === "rediss:") &&
    url.hostname.length > 0
  );
}

function isPostgresDatabaseUrl(value: string): boolean {
  const url = parsedUrl(value);
  if (url === null) return false;
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return false;
  const hasConnectionTarget =
    url.hostname.length > 0 || Boolean(url.searchParams.get("host")?.trim());
  const hasDatabaseName = url.pathname.length > 1;
  return hasConnectionTarget && hasDatabaseName;
}

function isGitHubAppId(value: string): boolean {
  return /^\d+$/.test(value);
}

function isGitHubAppPrivateKey(value: string): boolean {
  try {
    return createPrivateKey(value.replace(/\\n/g, "\n")).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}

function addProblem(
  problems: SelfHostPreflightProblem[],
  name: string,
  message: string,
): void {
  problems.push({ var: name, message });
}

export function preflightEnv(env: SelfHostPreflightEnv): SelfHostPreflightResult {
  const problems: SelfHostPreflightProblem[] = [];

  const redisUrl = nonBlank(env.REDIS_URL);
  if (!redisUrl || !isRedisUrl(redisUrl))
    addProblem(
      problems,
      "REDIS_URL",
      "Set REDIS_URL to the redis:// or rediss:// connection URL used for shared transient review state.",
    );

  const githubAppId = nonBlank(env.GITHUB_APP_ID);
  const githubAppPrivateKey = nonBlank(env.GITHUB_APP_PRIVATE_KEY);
  const hasPartialGitHubApp = Boolean(githubAppId || githubAppPrivateKey);
  if (hasPartialGitHubApp && !(githubAppId && githubAppPrivateKey)) {
    if (!githubAppId)
      addProblem(
        problems,
        "GITHUB_APP_ID",
        "Set GITHUB_APP_ID when configuring a GitHub App private key.",
      );
    if (!githubAppPrivateKey)
      addProblem(
        problems,
        "GITHUB_APP_PRIVATE_KEY",
        "Set GITHUB_APP_PRIVATE_KEY when configuring a GitHub App ID.",
      );
  }
  if (githubAppId && githubAppPrivateKey) {
    if (!isGitHubAppId(githubAppId))
      addProblem(
        problems,
        "GITHUB_APP_ID",
        "Set GITHUB_APP_ID to the numeric GitHub App ID.",
      );
    if (!isGitHubAppPrivateKey(githubAppPrivateKey))
      addProblem(
        problems,
        "GITHUB_APP_PRIVATE_KEY",
        "Set GITHUB_APP_PRIVATE_KEY to the PEM private key for the configured GitHub App.",
      );
  }

  const hasOrbBroker = Boolean(nonBlank(env.ORB_ENROLLMENT_SECRET));
  if (!hasPartialGitHubApp && !hasOrbBroker) {
    if (!nonBlank(env.SELFHOST_SETUP_TOKEN))
      addProblem(
        problems,
        "SELFHOST_SETUP_TOKEN",
        "Set SELFHOST_SETUP_TOKEN before using the first-run setup wizard.",
      );
    const publicApiOrigin = nonBlank(env.PUBLIC_API_ORIGIN);
    if (!publicApiOrigin || !isBareHttpsOrigin(publicApiOrigin))
      addProblem(
        problems,
        "PUBLIC_API_ORIGIN",
        "Set PUBLIC_API_ORIGIN to the public HTTPS origin that receives GitHub App setup callbacks.",
      );
  }

  const databaseUrl = nonBlank(env.DATABASE_URL);
  if (databaseUrl && !isPostgresDatabaseUrl(databaseUrl))
    addProblem(
      problems,
      "DATABASE_URL",
      "Set DATABASE_URL to a valid postgres:// URL with a database name, or leave it unset to use the SQLite backend.",
    );

  return problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems };
}

export function formatSelfHostPreflightError(problems: SelfHostPreflightProblem[]): string {
  return [
    "Self-host environment preflight failed:",
    ...problems.map((problem) => `- ${problem.var}: ${problem.message}`),
  ].join("\n");
}

export function assertSelfHostPreflight(env: SelfHostPreflightEnv): void {
  const result = preflightEnv(env);
  if (!result.ok) throw new Error(formatSelfHostPreflightError(result.problems));
}
