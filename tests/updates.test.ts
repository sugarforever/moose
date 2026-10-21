import { describe, expect, it } from "vitest";
import {
  UpdateController,
  UpdateRateLimit,
  type UpdatePlatform,
} from "../src/updates/controller";

const base = "https://github.com/sugarforever/moose/releases/download/v0.2.0/";
const manifest = {
  schema: 1,
  package: "dev.verysmallwoods.moose",
  version: "0.2.0",
  versionCode: 12,
  apk: "moose.apk",
  size: 3,
  sha256: "a".repeat(64),
};
const releases = [
  {
    draft: false,
    prerelease: true,
    body: "Update fixes",
    assets: [
      {
        name: "moose-update.json",
        browser_download_url: base + "moose-update.json",
      },
      { name: "moose.apk", browser_download_url: base + "moose.apk", size: 3 },
    ],
  },
];

function harness(overrides: Partial<UpdatePlatform> = {}) {
  let now = 1_000_000;
  let checkState = { nextCheck: 0, retryAt: 0 };
  let requests = 0;
  const effects: string[] = [];
  const platform: UpdatePlatform = {
    version: "0.1.0",
    versionCode: 1,
    now: () => now,
    readCheckState: async () => checkState,
    writeCheckState: async (value) => {
      checkState = value;
    },
    json: async (url) => {
      requests++;
      return url.includes("api.github.com") ? releases : manifest;
    },
    download: async (_update, _signal, progress) => {
      progress(0.5);
      effects.push("download");
    },
    verify: async () => {
      effects.push("verify");
    },
    removeDownload: async () => {
      effects.push("remove");
    },
    canInstall: async () => true,
    openPermission: async () => {
      effects.push("permission");
    },
    install: async () => {
      effects.push("install");
    },
    cancelInstall: () => {},
    ...overrides,
  };
  const controller = new UpdateController(platform);
  return {
    controller,
    effects,
    requests: () => requests,
    advance: (ms: number) => {
      now += ms;
    },
    platform,
  };
}

describe("Android updates", () => {
  it("discovers prereleases and verifies the APK before allowing installation", async () => {
    const h = harness();
    await h.controller.check(true);
    expect(h.controller.state.update?.versionCode).toBe(12);
    await h.controller.download();
    expect(h.controller.state.status).toBe("ready");
    await h.controller.install();
    expect(h.effects).toEqual(["download", "verify", "install"]);
    expect(h.controller.state.status).toBe("ready"); // installer launch isn't success
  });

  it("does not offer an equal or older build", async () => {
    const h = harness({ versionCode: 12 });
    await h.controller.check(true);
    expect(h.controller.state.update).toBeUndefined();
    expect(h.controller.state.status).toBe("idle");
  });

  it.each([
    { ...manifest, package: "other.app" },
    { ...manifest, sha256: "invalid" },
    { ...manifest, versionCode: 1.5 },
    { ...manifest, size: 4 },
    { ...manifest, apk: "../moose.apk" },
  ])("rejects invalid update metadata %j", async (bad) => {
    const h = harness({
      json: async (url) => (url.includes("api.github.com") ? releases : bad),
    });
    await h.controller.check(true);
    expect(h.controller.state.status).toBe("error");
    expect(h.controller.state.update).toBeUndefined();
  });

  it("rejects manifest and APK links outside the repository's HTTPS releases", async () => {
    for (const assetIndex of [0, 1]) {
      const bad = structuredClone(releases);
      bad[0].assets[assetIndex].browser_download_url =
        "https://evil.example/moose.apk";
      const h = harness({
        json: async (url) => (url.includes("api.github.com") ? bad : manifest),
      });
      await h.controller.check(true);
      expect(h.controller.state.status).toBe("error");
    }
  });

  it("skips legacy releases without a manifest", async () => {
    const h = harness({
      json: async (url) =>
        url.includes("api.github.com")
          ? [{ draft: false, assets: [] }, ...releases]
          : manifest,
    });
    await h.controller.check(true);
    expect(h.controller.state.status).toBe("available");
  });

  it("persists automatic throttling across controllers while allowing a manual check", async () => {
    const h = harness();
    await h.controller.check();
    const another = new UpdateController(h.platform);
    await another.check();
    expect(h.requests()).toBe(2);
    await another.check(true);
    expect(h.requests()).toBe(4);
    h.advance(6 * 60 * 60 * 1000);
    await another.check();
    expect(h.requests()).toBe(6);
  });

  it("prevents concurrent checks and does not publish a cancelled response", async () => {
    let resolve!: (value: unknown) => void;
    const h = harness({
      json: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const checking = h.controller.check(true);
    await new Promise((done) => setTimeout(done, 0));
    await h.controller.check(true);
    h.controller.cancel();
    resolve(releases);
    await checking;
    expect(h.controller.state.update).toBeUndefined();
    expect(h.controller.state.status).toBe("idle");
  });

  it("cleans partial downloads and ignores late completion after cancellation", async () => {
    let resolve!: () => void;
    const h = harness({
      download: () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    });
    await h.controller.check(true);
    const downloading = h.controller.download();
    h.controller.cancel();
    resolve();
    await downloading;
    expect(h.controller.state.status).toBe("available");
    expect(h.effects).toEqual(["remove"]);
  });

  it("never installs a corrupt or incompatible APK and permits a fresh download", async () => {
    const h = harness({
      verify: async () => {
        throw new Error("APK verification failed");
      },
    });
    await h.controller.check(true);
    await h.controller.download();
    await h.controller.install();
    expect(h.controller.state.status).toBe("error");
    expect(h.effects).toEqual(["download", "remove"]);
  });

  it("opens permission settings and waits for a second user install action", async () => {
    let allowed = false;
    const h = harness({ canInstall: async () => allowed });
    await h.controller.check(true);
    await h.controller.download();
    await h.controller.install();
    expect(h.effects).toEqual(["download", "verify", "permission"]);
    allowed = true;
    await h.controller.install();
    expect(h.effects.at(-1)).toBe("install");
  });

  it("respects server backoff even for manual checks after reopening", async () => {
    let requests = 0;
    const h = harness({
      json: async () => {
        requests++;
        throw new UpdateRateLimit(2_000_000);
      },
    });
    await h.controller.check(true);
    const reopened = new UpdateController(h.platform);
    await reopened.check(true);
    expect(requests).toBe(1);
    h.advance(1_000_001);
    await reopened.check(true);
    expect(requests).toBe(2);
  });

  it("selects the highest build code even when a legacy release is listed first", async () => {
    const olderBase = base.replace("v0.2.0", "v0.1.0");
    const older = structuredClone(releases[0]);
    older.assets = older.assets.map((asset) => ({
      ...asset,
      browser_download_url: asset.browser_download_url.replace(base, olderBase),
    }));
    const h = harness({
      json: async (url) =>
        url.includes("api.github.com")
          ? [older, ...releases]
          : url.includes("v0.1.0")
            ? { ...manifest, versionCode: 1 }
            : manifest,
    });
    await h.controller.check(true);
    expect(h.controller.state.update?.versionCode).toBe(12);
  });

  it("does not launch an installer after cancellation while checking permission", async () => {
    let resolve!: (value: boolean) => void;
    const h = harness({
      canInstall: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await h.controller.check(true);
    await h.controller.download();
    const installing = h.controller.install();
    h.controller.cancel();
    resolve(true);
    await installing;
    expect(h.effects).toEqual(["download", "verify"]);
  });

  it("allows redownloading when Android evicts the verified APK from cache", async () => {
    const h = harness({
      install: async () => {
        throw new Error("Package not found");
      },
    });
    await h.controller.check(true);
    await h.controller.download();
    await h.controller.install();
    expect(h.controller.state.status).toBe("error");
    await h.controller.download();
    expect(h.controller.state.status).toBe("ready");
  });

  it("does not publish a late rate-limit error after cancellation during persistence", async () => {
    let writes = 0;
    let resolve!: () => void;
    const h = harness({
      json: async () => {
        throw new UpdateRateLimit(2_000_000);
      },
      writeCheckState: async () => {
        if (++writes === 2)
          await new Promise<void>((done) => {
            resolve = done;
          });
      },
    });
    const checking = h.controller.check(true);
    await new Promise((done) => setTimeout(done, 0));
    h.controller.cancel();
    resolve();
    await checking;
    expect(h.controller.state.status).toBe("idle");
    expect(h.controller.state.message).toBe("");
  });
});
