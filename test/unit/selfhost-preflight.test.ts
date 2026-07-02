import { generateKeyPairSync } from "node:crypto";

import {
  assertSelfHostPreflight,
  formatSelfHostPreflightError,
  preflightEnv,
  type SelfHostPreflightProblem,
} from "../../src/selfhost/preflight";

describe("self-host environment preflight (#2080)", () => {
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  it("returns every missing required value at once for the first-run setup path", () => {
    const result = preflightEnv({});

    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({ var: "REDIS_URL" }),
        expect.objectContaining({ var: "SELFHOST_SETUP_TOKEN" }),
        expect.objectContaining({ var: "PUBLIC_API_ORIGIN" }),
      ],
    });
  });

  it("trims values, passes configured GitHub App installs, and accepts postgres URLs", () => {
    expect(
      preflightEnv({
        REDIS_URL: " redis://redis:6379 ",
        GITHUB_APP_ID: " 123 ",
        GITHUB_APP_PRIVATE_KEY: ` ${privateKey} `,
        DATABASE_URL: " postgres://gittensory:secret@postgres:5432/gittensory ",
      }),
    ).toEqual({ ok: true, problems: [] });

    expect(
      preflightEnv({
        REDIS_URL: "redis://redis:6379",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        DATABASE_URL: "postgresql://gittensory:secret@postgres:5432/gittensory",
      }),
    ).toEqual({ ok: true, problems: [] });

    expect(
      preflightEnv({
        REDIS_URL: "redis://redis:6379",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        DATABASE_URL: "postgresql:///gittensory?host=/var/run/postgresql",
      }),
    ).toEqual({ ok: true, problems: [] });

    expect(
      preflightEnv({
        REDIS_URL: "rediss://redis.example:6380",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
      }),
    ).toEqual({ ok: true, problems: [] });
  });

  it("requires setup-wizard vars only when neither a GitHub App nor Orb broker enrollment is configured", () => {
    expect(
      preflightEnv({
        REDIS_URL: "redis://redis:6379",
        SELFHOST_SETUP_TOKEN: "setup-secret",
        PUBLIC_API_ORIGIN: "https://selfhost.example",
      }),
    ).toEqual({ ok: true, problems: [] });

    expect(
      preflightEnv({
        REDIS_URL: "redis://redis:6379",
        ORB_ENROLLMENT_SECRET: "orb-secret",
      }),
    ).toEqual({ ok: true, problems: [] });
  });

  it("requires PUBLIC_API_ORIGIN to be a parseable bare HTTPS origin", () => {
    for (const PUBLIC_API_ORIGIN of [
      "not-a-url",
      "http://selfhost.example",
      "https://selfhost.example/setup",
      "https://user:password@selfhost.example",
    ]) {
      const result = preflightEnv({
        REDIS_URL: "redis://redis:6379",
        SELFHOST_SETUP_TOKEN: "setup-secret",
        PUBLIC_API_ORIGIN,
      });

      expect(result).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "PUBLIC_API_ORIGIN" })],
      });
      expect(JSON.stringify(result)).not.toContain(PUBLIC_API_ORIGIN);
    }
  });

  it("requires Redis to be a parseable redis URL", () => {
    for (const REDIS_URL of [
      "redis",
      "http://:redis-password@redis:6379",
      "redis://",
    ]) {
      const result = preflightEnv({
        REDIS_URL,
        SELFHOST_SETUP_TOKEN: "setup-secret",
        PUBLIC_API_ORIGIN: "https://selfhost.example",
      });

      expect(result).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "REDIS_URL" })],
      });
      expect(JSON.stringify(result)).not.toContain("redis-password");
    }
  });

  it("requires the complete GitHub App credential pair before bypassing setup", () => {
    const missingPrivateKey = preflightEnv({
      REDIS_URL: "redis://redis:6379",
      GITHUB_APP_ID: "123",
    });

    expect(missingPrivateKey).toEqual({
      ok: false,
      problems: [expect.objectContaining({ var: "GITHUB_APP_PRIVATE_KEY" })],
    });

    const missingAppId = preflightEnv({
      REDIS_URL: "redis://redis:6379",
      GITHUB_APP_PRIVATE_KEY: privateKey,
    });

    expect(missingAppId).toEqual({
      ok: false,
      problems: [expect.objectContaining({ var: "GITHUB_APP_ID" })],
    });
    expect(JSON.stringify(missingAppId)).not.toContain(privateKey.slice(0, 24));
  });

  it("requires parseable GitHub App credentials when setup is bypassed", () => {
    const result = preflightEnv({
      REDIS_URL: "redis://redis:6379",
      GITHUB_APP_ID: "not-a-number",
      GITHUB_APP_PRIVATE_KEY: "not-a-pem-private-key",
    });

    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({ var: "GITHUB_APP_ID" }),
        expect.objectContaining({ var: "GITHUB_APP_PRIVATE_KEY" }),
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("not-a-number");
    expect(serialized).not.toContain("not-a-pem-private-key");

    expect(
      preflightEnv({
        REDIS_URL: "redis://redis:6379",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "\\n",
      }),
    ).toEqual({
      ok: false,
      problems: [expect.objectContaining({ var: "GITHUB_APP_PRIVATE_KEY" })],
    });
  });

  it("requires DATABASE_URL to parse as a usable postgres DSN", () => {
    for (const DATABASE_URL of [
      "postgres://",
      "postgres://postgres",
      "postgresql:///gittensory",
      "sqlite:///tmp/gittensory.sqlite?password=super-secret-db",
    ]) {
      const result = preflightEnv({
        REDIS_URL: "redis://redis:6379",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
        DATABASE_URL,
      });

      expect(result).toEqual({
        ok: false,
        problems: [expect.objectContaining({ var: "DATABASE_URL" })],
      });
    }

    const secretBearing = preflightEnv({
      REDIS_URL: "redis://redis:6379",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKey,
      DATABASE_URL: "postgres://user:super-secret-db@/gittensory",
    });
    expect(JSON.stringify(secretBearing)).not.toContain("super-secret-db");
  });

  it("flags blank values and invalid DATABASE_URL while never echoing supplied secrets", () => {
    const result = preflightEnv({
      REDIS_URL: "   ",
      SELFHOST_SETUP_TOKEN: "secret-setup-token",
      PUBLIC_API_ORIGIN: "https://selfhost.example",
      DATABASE_URL: "sqlite:///tmp/gittensory.sqlite?password=super-secret-db",
    });

    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({ var: "REDIS_URL" }),
        expect.objectContaining({ var: "DATABASE_URL" }),
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret-setup-token");
    expect(serialized).not.toContain("super-secret-db");
    expect(serialized).not.toContain("sqlite:///tmp");
  });

  it("formats all problems with names and actionable hints", () => {
    const problems: SelfHostPreflightProblem[] = [
      { var: "REDIS_URL", message: "Set REDIS_URL to Redis." },
      { var: "PUBLIC_API_ORIGIN", message: "Set PUBLIC_API_ORIGIN to HTTPS." },
    ];

    expect(formatSelfHostPreflightError(problems)).toBe(
      "Self-host environment preflight failed:\n" +
        "- REDIS_URL: Set REDIS_URL to Redis.\n" +
        "- PUBLIC_API_ORIGIN: Set PUBLIC_API_ORIGIN to HTTPS.",
    );
  });

  it("asserts the preflight result for the boot path", () => {
    expect(() =>
      assertSelfHostPreflight({
        REDIS_URL: "redis://redis:6379",
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      }),
    ).not.toThrow();

    expect(() => assertSelfHostPreflight({ DATABASE_URL: "mysql://db/app" })).toThrow(
      /Self-host environment preflight failed:\n- REDIS_URL: .*SELFHOST_SETUP_TOKEN.*PUBLIC_API_ORIGIN.*DATABASE_URL:/s,
    );
  });
});
