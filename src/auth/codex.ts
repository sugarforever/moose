/** Portable Codex device-code protocol, following Pi and the official Codex client.
 * Sources and limitations: docs/chatgpt-subscription.md. No Node callback server.
 */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface DeviceChallenge {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
  attempt: number;
}
export interface BrowserChallenge {
  authorizationUrl: string;
  verifier: string;
  state: string;
  attempt: number;
  expiresAt: number;
}
export const CODEX_REDIRECT = "http://localhost:1455/auth/callback";
export function browserCallbackCode(input: string, state: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CodexAuthError("invalid_response", "Invalid sign-in callback");
  }
  if (
    url.origin !== "http://localhost:1455" ||
    url.pathname !== "/auth/callback" ||
    url.hash ||
    url.username ||
    url.password ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== state ||
    url.searchParams.getAll("code").length > 1 ||
    url.searchParams.getAll("error").length > 1
  )
    throw new CodexAuthError(
      "invalid_response",
      "Sign-in callback validation failed. Try again.",
    );
  if (url.searchParams.has("error"))
    throw new CodexAuthError(
      "denied",
      "Authorization was not completed. Sign in again.",
    );
  const code = url.searchParams.get("code");
  if (!code)
    throw new CodexAuthError(
      "invalid_response",
      "Sign-in callback is missing an authorization code",
    );
  return code;
}
interface Credential {
  version: 1;
  access: string;
  refresh: string;
  expiresAt: number;
  accountId: string;
}
export interface CodexStatus {
  connected: boolean;
  accountId?: string;
  expiresAt?: number;
}
type AuthCode =
  | "cancelled"
  | "expired"
  | "denied"
  | "unavailable"
  | "invalid_response"
  | "network"
  | "reauth_required";
export class CodexAuthError extends Error {
  constructor(
    readonly code: AuthCode,
    message: string,
  ) {
    super(message);
    this.name = "CodexAuthError";
  }
}
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // Public Codex client ID, also used by Pi/OpenCode; not a client secret.
const AUTH = "https://auth.openai.com";
const STORAGE_KEY = "moose.auth.codex.v1";
const cancelled = () => new CodexAuthError("cancelled", "Sign-in cancelled");
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CodexAuthError(
      "invalid_response",
      "The authorization service returned an unrecognized response",
    );
  return value as Record<string, unknown>;
}
function errorCode(body: Record<string, unknown>) {
  if (typeof body.error === "string") return body.error;
  if (body.error && typeof body.error === "object")
    return (body.error as Record<string, unknown>).code;
  return undefined;
}
function parseCredential(
  body: Record<string, unknown>,
  now: number,
  previous?: Credential,
): Credential {
  const access = body.access_token;
  const refresh = body.refresh_token ?? previous?.refresh;
  const seconds = body.expires_in;
  if (
    typeof access !== "string" ||
    !access ||
    typeof refresh !== "string" ||
    !refresh ||
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  )
    throw new CodexAuthError(
      "invalid_response",
      "The token response is missing required fields",
    );
  // Claims are routing metadata from the HTTPS token response, not independently verified identity.
  // The Codex backend verifies the bearer token. Never use these claims as an app authorization decision.
  let accountId: unknown;
  try {
    const parts = access.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(
      atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")),
    );
    accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    throw new CodexAuthError(
      "invalid_response",
      "The authorization token is missing Codex account information",
    );
  }
  if (typeof accountId !== "string" || !accountId)
    throw new CodexAuthError(
      "invalid_response",
      "The authorization token is missing Codex account information",
    );
  if (previous && previous.accountId !== accountId)
    throw new CodexAuthError(
      "invalid_response",
      "The refreshed account does not match the original account. Sign in again.",
    );
  return {
    version: 1,
    access,
    refresh,
    expiresAt: now + seconds * 1000,
    accountId,
  };
}

export class CodexAuth {
  private tail: Promise<unknown> = Promise.resolve();
  private attempt = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(
    private store: SecretStore,
    private fetcher: typeof fetch = fetch,
    options: {
      now?: () => number;
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }
  private queue<T>(fn: () => Promise<T>) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  private assert(signal: AbortSignal, attempt?: number) {
    if (signal.aborted || (attempt !== undefined && attempt !== this.attempt))
      throw cancelled();
  }
  private async request(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    timeout = 30000,
  ) {
    this.assert(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeout));
    try {
      const response = await this.fetcher(url, {
        ...init,
        signal: controller.signal,
      });
      this.assert(signal);
      let body: Record<string, unknown> = {};
      try {
        body = object(await response.json());
      } catch {
        if (response.ok)
          throw new CodexAuthError(
            "invalid_response",
            "The authorization service returned an unrecognized response",
          );
      }
      this.assert(signal);
      return { response, body };
    } catch (error) {
      this.assert(signal);
      if (error instanceof CodexAuthError) throw error;
      throw new CodexAuthError(
        "network",
        controller.signal.aborted
          ? "Authorization request timed out. Try again."
          : "Unable to connect to the authorization service. Check your connection.",
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
  async begin(signal: AbortSignal): Promise<DeviceChallenge> {
    this.assert(signal);
    const attempt = ++this.attempt;
    const { response, body } = await this.request(
      `${AUTH}/api/accounts/deviceauth/usercode`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID }),
      },
      signal,
    );
    this.assert(signal, attempt);
    if (!response.ok)
      throw new CodexAuthError(
        "unavailable",
        `Unable to request a device code (${response.status}). Check that your account or workspace allows Codex device code sign-in.`,
      );
    const deviceAuthId = body.device_auth_id;
    const userCode = body.user_code ?? body.usercode;
    const interval = body.interval === undefined ? 5 : Number(body.interval);
    if (
      typeof deviceAuthId !== "string" ||
      !deviceAuthId ||
      typeof userCode !== "string" ||
      !userCode ||
      !Number.isFinite(interval) ||
      interval < 0
    )
      throw new CodexAuthError(
        "invalid_response",
        "The device authorization response is missing required fields",
      );
    const expires =
      typeof body.expires_in === "number" && body.expires_in > 0
        ? Math.min(900, body.expires_in)
        : 900;
    return {
      deviceAuthId,
      userCode,
      verificationUri: `${AUTH}/codex/device`,
      intervalMs: Math.max(1000, Math.min(60000, interval * 1000)),
      expiresAt: this.now() + expires * 1000,
      attempt,
    };
  }
  async complete(
    challenge: DeviceChallenge,
    signal: AbortSignal,
  ): Promise<CodexStatus> {
    let interval = challenge.intervalMs;
    while (true) {
      this.assert(signal, challenge.attempt);
      const remaining = challenge.expiresAt - this.now();
      if (remaining <= 0)
        throw new CodexAuthError(
          "expired",
          "The device code has expired. Start sign-in again.",
        );
      await this.sleep(Math.min(interval, remaining), signal);
      this.assert(signal, challenge.attempt);
      if (this.now() >= challenge.expiresAt)
        throw new CodexAuthError(
          "expired",
          "The device code has expired. Start sign-in again.",
        );
      const { response, body } = await this.request(
        `${AUTH}/api/accounts/deviceauth/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            device_auth_id: challenge.deviceAuthId,
            user_code: challenge.userCode,
          }),
        },
        signal,
        Math.min(30000, challenge.expiresAt - this.now()),
      );
      this.assert(signal, challenge.attempt);
      const code = errorCode(body);
      if (code === "access_denied" || code === "deviceauth_access_denied")
        throw new CodexAuthError("denied", "You denied this authorization");
      if (code === "expired_token" || code === "expired_code")
        throw new CodexAuthError(
          "expired",
          "The device code has expired. Start sign-in again.",
        );
      if (code === "slow_down" || response.status === 429) {
        interval = Math.min(60000, interval + 5000);
        continue;
      }
      if (response.ok) {
        if (
          typeof body.authorization_code !== "string" ||
          typeof body.code_verifier !== "string"
        )
          throw new CodexAuthError(
            "invalid_response",
            "The authorization response is missing token exchange information",
          );
        const result = await this.request(
          `${AUTH}/oauth/token`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: CLIENT_ID,
              code: body.authorization_code,
              code_verifier: body.code_verifier,
              redirect_uri: `${AUTH}/deviceauth/callback`,
            }).toString(),
          },
          signal,
        );
        if (!result.response.ok)
          throw new CodexAuthError(
            "reauth_required",
            `Token exchange failed (${result.response.status}). Sign in again.`,
          );
        return this.saveLogin(result.body, signal, challenge.attempt);
      }
      if (
        code === "authorization_pending" ||
        code === "deviceauth_authorization_pending" ||
        response.status === 403 ||
        response.status === 404
      )
        continue;
      throw new CodexAuthError(
        "unavailable",
        `Device authorization failed (${response.status}). Sign in again.`,
      );
    }
  }
  beginBrowser(
    pkce: { verifier: string; challenge: string; state: string },
    signal: AbortSignal,
  ): BrowserChallenge {
    this.assert(signal);
    if (
      ![pkce.verifier, pkce.challenge, pkce.state].every((value) =>
        /^[A-Za-z0-9_-]{43,128}$/.test(value),
      )
    )
      throw new CodexAuthError(
        "invalid_response",
        "Unable to generate a secure sign-in request",
      );
    const attempt = ++this.attempt;
    const url = new URL(`${AUTH}/oauth/authorize`);
    Object.entries({
      client_id: CLIENT_ID,
      redirect_uri: CODEX_REDIRECT,
      response_type: "code",
      scope: "openid profile email offline_access",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: pkce.state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "moose",
    }).forEach(([key, value]) => url.searchParams.set(key, value));
    return {
      authorizationUrl: url.toString(),
      verifier: pkce.verifier,
      state: pkce.state,
      attempt,
      expiresAt: this.now() + 300000,
    };
  }
  async completeBrowser(
    challenge: BrowserChallenge,
    callback: string,
    signal: AbortSignal,
  ): Promise<CodexStatus> {
    this.assert(signal, challenge.attempt);
    if (this.now() >= challenge.expiresAt)
      throw new CodexAuthError("expired", "Sign-in timed out. Try again.");
    const code = browserCallbackCode(callback, challenge.state);
    const result = await this.request(
      `${AUTH}/oauth/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code,
          code_verifier: challenge.verifier,
          redirect_uri: CODEX_REDIRECT,
        }).toString(),
      },
      signal,
    );
    if (!result.response.ok)
      throw new CodexAuthError(
        "reauth_required",
        `Token exchange failed (${result.response.status}). Sign in again.`,
      );
    return this.saveLogin(result.body, signal, challenge.attempt);
  }
  private async saveLogin(
    body: Record<string, unknown>,
    signal: AbortSignal,
    attempt: number,
  ): Promise<CodexStatus> {
    const credential = parseCredential(body, this.now());
    await this.queue(async () => {
      this.assert(signal, attempt);
      const previous = await this.store.get(STORAGE_KEY);
      this.assert(signal, attempt);
      await this.store.set(STORAGE_KEY, JSON.stringify(credential));
      try {
        this.assert(signal, attempt);
      } catch (error) {
        if (previous === null) await this.store.remove(STORAGE_KEY);
        else await this.store.set(STORAGE_KEY, previous);
        throw error;
      }
    });
    this.assert(signal, attempt);
    return this.status();
  }
  private async read(): Promise<Credential | null> {
    const raw = await this.store.get(STORAGE_KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as Credential;
      if (
        value.version !== 1 ||
        typeof value.access !== "string" ||
        !value.access ||
        typeof value.refresh !== "string" ||
        !value.refresh ||
        typeof value.accountId !== "string" ||
        !value.accountId ||
        !Number.isFinite(value.expiresAt)
      )
        throw new Error("Invalid stored credential");
      return value;
    } catch {
      throw new CodexAuthError(
        "invalid_response",
        "Unable to read saved sign-in information. Sign out and sign in again.",
      );
    }
  }
  async status(): Promise<CodexStatus> {
    const value = await this.read();
    return value
      ? {
          connected: true,
          accountId: value.accountId,
          expiresAt: value.expiresAt,
        }
      : { connected: false };
  }
  getAccessToken(
    signal = new AbortController().signal,
  ): Promise<string | null> {
    const attempt = this.attempt;
    return this.queue(async () => {
      this.assert(signal, attempt);
      const current = await this.read();
      this.assert(signal, attempt);
      if (!current) return null;
      if (current.expiresAt > this.now() + 60000) return current.access;
      const { response, body } = await this.request(
        `${AUTH}/oauth/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: current.refresh,
            client_id: CLIENT_ID,
          }).toString(),
        },
        signal,
      );
      this.assert(signal, attempt);
      if (!response.ok) {
        if (errorCode(body) === "invalid_grant" || response.status === 401) {
          await this.store.remove(STORAGE_KEY);
          throw new CodexAuthError(
            "reauth_required",
            "Your ChatGPT sign-in has expired. Authorize again.",
          );
        }
        throw new CodexAuthError(
          "network",
          `Unable to refresh ChatGPT sign-in (${response.status}). Try again later.`,
        );
      }
      const next = parseCredential(body, this.now(), current);
      await this.store.set(STORAGE_KEY, JSON.stringify(next));
      this.assert(signal, attempt);
      return next.access;
    });
  }
  cancelPending() {
    this.attempt++;
  }
  logout() {
    this.attempt++;
    return this.queue(() => this.store.remove(STORAGE_KEY));
  }
}
