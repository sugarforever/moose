export const RELEASES_URL =
  "https://api.github.com/repos/sugarforever/moose/releases?per_page=20";
const RELEASE_PREFIX =
  "https://github.com/sugarforever/moose/releases/download/";
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export interface AndroidUpdate {
  version: string;
  versionCode: number;
  url: string;
  size: number;
  sha256: string;
  notes: string;
}
export interface UpdatePlatform {
  version: string;
  versionCode: number;
  now(): number;
  readCheckState(): Promise<{ nextCheck: number; retryAt: number }>;
  writeCheckState(state: { nextCheck: number; retryAt: number }): Promise<void>;
  json(url: string, signal: AbortSignal): Promise<unknown>;
  download(
    update: AndroidUpdate,
    signal: AbortSignal,
    progress: (value: number) => void,
  ): Promise<void>;
  verify(update: AndroidUpdate): Promise<void>;
  removeDownload(): Promise<void>;
  canInstall(): Promise<boolean>;
  openPermission(): Promise<void>;
  install(update: AndroidUpdate): Promise<void>;
  cancelInstall(): void;
}
export interface UpdateState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "verifying"
    | "ready"
    | "installing"
    | "error";
  update?: AndroidUpdate;
  progress: number;
  message: string;
}
export class UpdateRateLimit extends Error {
  constructor(public readonly until: number) {
    super("GitHub 请求过于频繁，请稍后检查");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("更新信息格式错误");
  return value as Record<string, unknown>;
}
function assetUrl(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(RELEASE_PREFIX))
    throw new Error("更新附件地址无效");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== value ||
    (!url.pathname.endsWith(".apk") &&
      !url.pathname.endsWith("/moose-update.json"))
  ) {
    throw new Error("更新附件地址无效");
  }
  return value;
}

async function discover(
  platform: UpdatePlatform,
  signal: AbortSignal,
): Promise<AndroidUpdate | undefined> {
  const data = await platform.json(RELEASES_URL, signal);
  signal.throwIfAborted();
  if (!Array.isArray(data)) throw new Error("GitHub 更新列表格式错误");
  let latest: AndroidUpdate | undefined;
  for (const item of data.slice(0, 20)) {
    const release = object(item);
    if (release.draft === true || !Array.isArray(release.assets)) continue;
    const assets = release.assets.map(object);
    const metadata = assets.find((asset) => asset.name === "moose-update.json");
    if (!metadata) continue;
    const manifestUrl = assetUrl(metadata.browser_download_url);
    const manifest = object(await platform.json(manifestUrl, signal));
    signal.throwIfAborted();
    if (
      manifest.schema !== 1 ||
      manifest.package !== "dev.verysmallwoods.moose" ||
      typeof manifest.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) ||
      !Number.isSafeInteger(manifest.versionCode) ||
      (manifest.versionCode as number) < 1 ||
      (manifest.versionCode as number) > 2_100_000_000 ||
      typeof manifest.apk !== "string" ||
      !/^[\w.-]+\.apk$/.test(manifest.apk) ||
      typeof manifest.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !Number.isSafeInteger(manifest.size) ||
      (manifest.size as number) <= 0 ||
      (manifest.size as number) >= 2 ** 31
    ) {
      throw new Error("更新清单校验失败");
    }
    const apk = assets.find((asset) => asset.name === manifest.apk);
    if (!apk || apk.size !== manifest.size)
      throw new Error("更新安装包信息不匹配");
    const url = assetUrl(apk.browser_download_url);
    if (
      url.slice(0, url.lastIndexOf("/")) !==
      manifestUrl.slice(0, manifestUrl.lastIndexOf("/"))
    )
      throw new Error("更新附件不属于同一版本");
    if (
      (manifest.versionCode as number) <=
      Math.max(platform.versionCode, latest?.versionCode ?? 0)
    )
      continue;
    latest = {
      version: manifest.version,
      versionCode: manifest.versionCode as number,
      url,
      size: manifest.size as number,
      sha256: manifest.sha256,
      notes:
        typeof release.body === "string" ? release.body.slice(0, 8000) : "",
    };
  }
  return latest;
}

/** App-scoped controller: one operation at a time; cancelled work cannot publish state. */
export class UpdateController {
  state: UpdateState = { status: "idle", progress: 0, message: "" };
  private listeners = new Set<() => void>();
  private operation?: AbortController;
  private retryAt = 0;
  constructor(readonly platform: UpdatePlatform) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.state;
  private publish(change: Partial<UpdateState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
  cancel = () => {
    this.operation?.abort();
    if (this.state.status === "installing") this.platform.cancelInstall();
  };

  async check(manual = false) {
    if (this.operation || this.state.status === "ready") return;
    const operation = (this.operation = new AbortController());
    const previous = this.state;
    try {
      const saved = await this.platform.readCheckState();
      operation.signal.throwIfAborted();
      this.retryAt = Math.max(this.retryAt, saved.retryAt);
      if (this.platform.now() < this.retryAt) {
        if (manual)
          this.publish({ message: "GitHub 请求过于频繁，请稍后检查" });
        return;
      }
      if (!manual && this.platform.now() < saved.nextCheck) return;
      operation.signal.throwIfAborted();
      // Persist attempts as well as successes, so offline launches don't hammer the API.
      await this.platform.writeCheckState({
        nextCheck: this.platform.now() + CHECK_INTERVAL,
        retryAt: this.retryAt,
      });
      operation.signal.throwIfAborted();
      this.publish({ status: "checking", message: "", update: undefined });
      const update = await discover(this.platform, operation.signal);
      operation.signal.throwIfAborted();
      this.publish({
        status: update ? "available" : "idle",
        update,
        message: update ? "" : "当前已是最新版本",
      });
    } catch (error) {
      if (operation.signal.aborted) this.publish(previous);
      else {
        if (error instanceof UpdateRateLimit) {
          this.retryAt = error.until;
          await this.platform
            .writeCheckState({
              nextCheck: Math.max(
                error.until,
                this.platform.now() + CHECK_INTERVAL,
              ),
              retryAt: error.until,
            })
            .catch(() => {});
        }
        if (operation.signal.aborted) {
          this.publish(previous);
          return;
        }
        this.publish({
          status: "error",
          update: undefined,
          message: error instanceof Error ? error.message : "检查更新失败",
        });
      }
    } finally {
      this.operation = undefined;
    }
  }

  async download() {
    if (this.operation || !this.state.update || this.state.status === "ready")
      return;
    const update = this.state.update;
    const operation = (this.operation = new AbortController());
    this.publish({ status: "downloading", progress: 0, message: "" });
    try {
      await this.platform.download(update, operation.signal, (progress) => {
        if (!operation.signal.aborted)
          this.publish({ progress: Math.max(0, Math.min(1, progress)) });
      });
      operation.signal.throwIfAborted();
      this.publish({ status: "verifying" });
      await this.platform.verify(update);
      operation.signal.throwIfAborted();
      this.publish({ status: "ready", progress: 1 });
    } catch (error) {
      await this.platform.removeDownload().catch(() => {});
      this.publish({
        status: operation.signal.aborted ? "available" : "error",
        progress: 0,
        message: operation.signal.aborted
          ? "已取消下载"
          : error instanceof Error
            ? error.message
            : "下载更新失败",
      });
    } finally {
      this.operation = undefined;
    }
  }

  async install() {
    if (this.operation || this.state.status !== "ready" || !this.state.update)
      return;
    const operation = (this.operation = new AbortController());
    this.publish({ status: "installing", message: "" });
    try {
      const allowed = await this.platform.canInstall();
      operation.signal.throwIfAborted();
      if (!allowed) {
        await this.platform.openPermission();
        operation.signal.throwIfAborted();
        this.publish({
          status: "ready",
          message: "请允许安装应用，返回后再次点击安装",
        });
      } else {
        await this.platform.install(this.state.update);
        operation.signal.throwIfAborted();
        this.publish({
          status: "ready",
          message: "请在系统界面确认安装；取消后可再次安装",
        });
      }
    } catch (error) {
      if (operation.signal.aborted)
        this.publish({ status: "ready", message: "" });
      else {
        await this.platform.removeDownload().catch(() => {});
        this.publish({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "打开安装界面失败，请重新下载",
        });
      }
    } finally {
      this.operation = undefined;
    }
  }
}
