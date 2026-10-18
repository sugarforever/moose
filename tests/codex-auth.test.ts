import { expect, it } from "vitest";
import { CodexAuth, type SecretStore } from "../src/auth/codex";

function token(account = "account-test") {
  return `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).replace(/=/g, "")}.signature`;
}
function fixture(responses: (Response | (() => Promise<Response>))[]) {
  let now = 1000;
  const secrets = new Map<string, string>();
  const store: SecretStore = {
    get: async (key) => secrets.get(key) ?? null,
    set: async (key, value) => {
      secrets.set(key, value);
    },
    remove: async (key) => {
      secrets.delete(key);
    },
  };
  const requests: Request[] = [];
  const waits: number[] = [];
  const auth = new CodexAuth(
    store,
    async (input, init) => {
      requests.push(new Request(input, init));
      const next = responses.shift();
      if (!next) throw new Error("Unexpected request");
      return typeof next === "function" ? next() : next;
    },
    {
      now: () => now,
      sleep: async (ms, signal) => {
        signal.throwIfAborted();
        waits.push(ms);
        now += ms;
      },
    },
  );
  return {
    auth,
    requests,
    waits,
    secrets,
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const device = () =>
  json({
    device_auth_id: "device-private",
    user_code: "ABCD-1234",
    interval: "2",
  });
const tokens = (refresh = "refresh-one") =>
  json({ access_token: token(), refresh_token: refresh, expires_in: 3600 });

it("finishes device-code login without a loopback listener and keeps secrets out of status", async () => {
  const f = fixture([
    device(),
    json({ error: "authorization_pending" }, 403),
    json({
      authorization_code: "authorization-private",
      code_verifier: "verifier-private",
    }),
    tokens(),
  ]);
  const challenge = await f.auth.begin(new AbortController().signal);
  expect(challenge.verificationUri).toBe(
    "https://auth.openai.com/codex/device",
  );
  expect(challenge.userCode).toBe("ABCD-1234");
  await f.auth.complete(challenge, new AbortController().signal);
  expect((await f.auth.status()).connected).toBe(true);
  expect((await f.auth.status()).accountId).toBe("account-test");
  expect(JSON.stringify(await f.auth.status())).not.toContain("refresh-one");
  expect(f.requests.map((r) => r.url)).toEqual([
    "https://auth.openai.com/api/accounts/deviceauth/usercode",
    "https://auth.openai.com/api/accounts/deviceauth/token",
    "https://auth.openai.com/api/accounts/deviceauth/token",
    "https://auth.openai.com/oauth/token",
  ]);
  const exchange = new URLSearchParams(await f.requests[3].text());
  expect(exchange.get("redirect_uri")).toBe(
    "https://auth.openai.com/deviceauth/callback",
  );
  expect(exchange.get("code_verifier")).toBe("verifier-private");
  expect(await f.auth.getAccessToken()).toBe(token());
});

it("backs off slow_down and never polls beyond the challenge expiry", async () => {
  const f = fixture([
    device(),
    json({ error: "slow_down" }, 429),
    json({ error: "authorization_pending" }, 403),
  ]);
  const challenge = await f.auth.begin(new AbortController().signal);
  challenge.expiresAt = 11000;
  await expect(
    f.auth.complete(challenge, new AbortController().signal),
  ).rejects.toMatchObject({ code: "expired" });
  expect(f.waits).toEqual([2000, 7000, 1000]);
  expect(f.requests).toHaveLength(3);
  expect(f.secrets.size).toBe(0);
});

it("stops on cancellation and denial, and rejects completion after logout", async () => {
  const f = fixture([device(), json({ error: "access_denied" }, 403)]);
  const challenge = await f.auth.begin(new AbortController().signal);
  await expect(
    f.auth.complete(challenge, new AbortController().signal),
  ).rejects.toMatchObject({ code: "denied" });
  const controller = new AbortController();
  controller.abort();
  await expect(f.auth.begin(controller.signal)).rejects.toMatchObject({
    code: "cancelled",
  });
  await f.auth.logout();
  await expect(
    f.auth.complete(challenge, new AbortController().signal),
  ).rejects.toMatchObject({ code: "cancelled" });
  expect(f.requests).toHaveLength(2);
});

it("serializes concurrent refresh, persists rotated tokens, and logout wins over an in-flight refresh", async () => {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<Response>();
  const f = fixture([
    device(),
    json({ authorization_code: "code", code_verifier: "verifier" }),
    tokens(),
    tokens("refresh-two"),
    async () => {
      started.resolve();
      return gate.promise;
    },
  ]);
  const challenge = await f.auth.begin(new AbortController().signal);
  await f.auth.complete(challenge, new AbortController().signal);
  f.advance(3600000);
  expect(
    await Promise.all([f.auth.getAccessToken(), f.auth.getAccessToken()]),
  ).toEqual([token(), token()]);
  expect(f.requests.filter((r) => r.url.endsWith("/oauth/token"))).toHaveLength(
    2,
  );
  expect([...f.secrets.values()].join("")).toContain("refresh-two");
  f.advance(3600000);
  // The queue must serialize logout after the already-admitted refresh and remove its result.
  const original = f.auth;
  const refreshRequest = original.getAccessToken();
  await started.promise;
  const loggingOut = original.logout();
  gate.resolve(tokens("refresh-three"));
  await expect(refreshRequest).rejects.toMatchObject({ code: "cancelled" });
  await loggingOut;
  expect((await f.auth.status()).connected).toBe(false);
  expect(f.secrets.size).toBe(0);
});

it("removes invalid refresh credentials but retains them on transient failure without leaking server bodies", async () => {
  const f = fixture([
    device(),
    json({ authorization_code: "code", code_verifier: "verifier" }),
    tokens(),
    json({ error: "server_error", secret: "never-show" }, 500),
    json({ error: "invalid_grant", secret: "never-show" }, 400),
  ]);
  const challenge = await f.auth.begin(new AbortController().signal);
  await f.auth.complete(challenge, new AbortController().signal);
  f.advance(3600000);
  await expect(f.auth.getAccessToken()).rejects.not.toThrow("never-show");
  expect((await f.auth.status()).connected).toBe(true);
  await expect(f.auth.getAccessToken()).rejects.toMatchObject({
    code: "reauth_required",
  });
  expect((await f.auth.status()).connected).toBe(false);
});

it("cancels an active polling wait immediately and never persists credentials", async () => {
  const secrets = new Map<string, string>();
  const store: SecretStore = {
    get: async (key) => secrets.get(key) ?? null,
    set: async (key, value) => {
      secrets.set(key, value);
    },
    remove: async (key) => {
      secrets.delete(key);
    },
  };
  let calls = 0;
  const auth = new CodexAuth(store, async () => {
    calls++;
    return device();
  });
  const controller = new AbortController();
  const challenge = await auth.begin(controller.signal);
  const pending = auth.complete(challenge, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  expect(calls).toBe(1);
  expect(secrets.size).toBe(0);
});

it("rejects malformed successful token responses without echoing tokens into an error", async () => {
  const f = fixture([
    device(),
    json({ authorization_code: "code", code_verifier: "verifier" }),
    json({
      access_token: "sensitive-token",
      refresh_token: "sensitive-refresh",
      expires_in: 3600,
    }),
  ]);
  const challenge = await f.auth.begin(new AbortController().signal);
  let failure: unknown;
  try {
    await f.auth.complete(challenge, new AbortController().signal);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "invalid_response" });
  expect(String(failure)).not.toContain("sensitive-token");
  expect(String(failure)).not.toContain("sensitive-refresh");
  expect(f.secrets.size).toBe(0);
});

it.each([false, true])(
  "rolls back cancelled login during credential persistence (existing=%s)",
  async (existing) => {
    const f = fixture([
      device(),
      json({ authorization_code: "code", code_verifier: "verifier" }),
      tokens(),
    ]);
    if (existing) f.secrets.set("moose.auth.codex.v1", "previous-credential");
    let entered!: () => void;
    let release!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalSet = f.store.set;
    let first = true;
    f.store.set = async (key, value) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      await originalSet(key, value);
    };
    const controller = new AbortController();
    const challenge = await f.auth.begin(controller.signal);
    const completion = f.auth.complete(challenge, controller.signal);
    const rejected = expect(completion).rejects.toMatchObject({
      code: "cancelled",
    });
    await writing;
    controller.abort();
    f.auth.cancelPending();
    release();
    await rejected;
    expect(f.secrets.get("moose.auth.codex.v1")).toBe(
      existing ? "previous-credential" : undefined,
    );
  },
);

it("does not return refreshed credentials when logout begins during persistence", async () => {
  const f = fixture([
    device(),
    json({ authorization_code: "code", code_verifier: "verifier" }),
    tokens(),
    tokens("rotated"),
  ]);
  const controller = new AbortController();
  await f.auth.complete(
    await f.auth.begin(controller.signal),
    controller.signal,
  );
  f.advance(3600000);
  let entered!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalSet = f.store.set;
  f.store.set = async (key, value) => {
    entered();
    await gate;
    await originalSet(key, value);
  };
  const refresh = f.auth.getAccessToken();
  const rejected = expect(refresh).rejects.toMatchObject({ code: "cancelled" });
  await writing;
  const logout = f.auth.logout();
  release();
  await rejected;
  await logout;
  expect(f.secrets.size).toBe(0);
});

it("validates browser callback state and exchanges its code using the original PKCE verifier", async () => {
  const f = fixture([tokens()]);
  const controller = new AbortController();
  const challenge = f.auth.beginBrowser(
    {
      verifier: "v".repeat(43),
      challenge: "c".repeat(43),
      state: "s".repeat(43),
    },
    controller.signal,
  );
  const url = new URL(challenge.authorizationUrl);
  expect(url.searchParams.get("redirect_uri")).toBe(
    "http://localhost:1455/auth/callback",
  );
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  await expect(
    f.auth.completeBrowser(
      challenge,
      "http://localhost:1455/auth/callback?code=secret&state=wrong",
      controller.signal,
    ),
  ).rejects.toMatchObject({ code: "invalid_response" });
  expect(f.requests).toHaveLength(0);
  await f.auth.completeBrowser(
    challenge,
    `http://localhost:1455/auth/callback?code=code&state=${challenge.state}`,
    controller.signal,
  );
  const body = new URLSearchParams(await f.requests[0].text());
  expect(body.get("code_verifier")).toBe("v".repeat(43));
  expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
  expect((await f.auth.status()).connected).toBe(true);
});

it.each([
  "http://evil.test/auth/callback",
  "http://localhost:1455/wrong",
  "http://localhost:1455/auth/callback?code=a&code=b",
  "http://localhost:1455/auth/callback?error=access_denied",
])("rejects invalid or denied browser callbacks: %s", async (input) => {
  const f = fixture([]);
  const signal = new AbortController().signal;
  const challenge = f.auth.beginBrowser(
    {
      verifier: "v".repeat(43),
      challenge: "c".repeat(43),
      state: "s".repeat(43),
    },
    signal,
  );
  const url = new URL(input);
  url.searchParams.set("state", challenge.state);
  await expect(
    f.auth.completeBrowser(challenge, url.toString(), signal),
  ).rejects.toBeInstanceOf(Error);
  expect(f.requests).toHaveLength(0);
  expect(f.secrets.size).toBe(0);
});

it("rejects expired or superseded browser challenges before token exchange", async () => {
  const f = fixture([]);
  const signal = new AbortController().signal;
  const pkce = {
    verifier: "v".repeat(43),
    challenge: "c".repeat(43),
    state: "s".repeat(43),
  };
  const first = f.auth.beginBrowser(pkce, signal);
  const second = f.auth.beginBrowser(pkce, signal);
  const callback = `http://localhost:1455/auth/callback?code=code&state=${pkce.state}`;
  await expect(
    f.auth.completeBrowser(first, callback, signal),
  ).rejects.toMatchObject({ code: "cancelled" });
  f.advance(300001);
  await expect(
    f.auth.completeBrowser(second, callback, signal),
  ).rejects.toMatchObject({ code: "expired" });
  expect(f.requests).toHaveLength(0);
});
