import { createServer, createConnection } from "node:net";
import { expect, it } from "vitest";
import { startLoopback, type TcpFactory } from "../src/auth/loopback";
const tcp = { createServer } as unknown as TcpFactory;
function request(port: number, data: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ port, host: "127.0.0.1" }, () =>
      socket.write(data),
    );
    let response = "";
    socket.on("data", (chunk) => (response += chunk.toString()));
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}
it("ignores unrelated and wrong-state requests, then captures a matching callback and releases the port", async () => {
  const controller = new AbortController();
  const listener = await startLoopback(tcp, {
    port: 0,
    state: "expected",
    signal: controller.signal,
  });
  const port = listener.port;
  expect(
    await request(port, "GET /favicon.ico HTTP/1.1\r\nHost: localhost\r\n\r\n"),
  ).toContain("404");
  expect(
    await request(
      port,
      "GET /auth/callback?code=bad&state=wrong HTTP/1.1\r\nHost: localhost\r\n\r\n",
    ),
  ).toContain("400");
  expect(
    await request(
      port,
      "GET /auth/callback?code=good&state=expected HTTP/1.1\r\nHost: localhost\r\n\r\n",
    ),
  ).toContain("200");
  expect(await listener.result).toBe(
    "http://localhost:1455/auth/callback?code=good&state=expected",
  );
  await listener.close();
  const replacement = await startLoopback(tcp, {
    port,
    state: "next",
    signal: new AbortController().signal,
  });
  await replacement.close();
});
it("closes pending sockets and rejects on cancel or timeout", async () => {
  const controller = new AbortController();
  const listener = await startLoopback(tcp, {
    port: 0,
    state: "state",
    signal: controller.signal,
  });
  const pending = expect(listener.result).rejects.toMatchObject({
    code: "cancelled",
  });
  controller.abort();
  await pending;
  await listener.close();
  const timeout = await startLoopback(tcp, {
    port: 0,
    state: "state",
    signal: new AbortController().signal,
    timeoutMs: 20,
  });
  await expect(timeout.result).rejects.toMatchObject({ code: "expired" });
  await timeout.close();
});
it("reports bind errors before any browser can open", async () => {
  const first = await startLoopback(tcp, {
    port: 0,
    state: "x",
    signal: new AbortController().signal,
  });
  await expect(
    startLoopback(tcp, {
      port: first.port,
      state: "x",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  await first.close();
});

it("rejects oversized and non-GET requests without consuming the login", async () => {
  const listener = await startLoopback(tcp, {
    port: 0,
    state: "state",
    signal: new AbortController().signal,
  });
  expect(
    await request(
      listener.port,
      `GET / HTTP/1.1\r\nX-Fill: ${"x".repeat(8200)}\r\n\r\n`,
    ),
  ).toContain("431");
  expect(
    await request(
      listener.port,
      "POST /auth/callback?code=x&state=state HTTP/1.1\r\n\r\n",
    ),
  ).toContain("400");
  expect(
    await request(
      listener.port,
      "GET /auth/callback?error=access_denied&state=state HTTP/1.1\r\n\r\n",
    ),
  ).toContain("200");
  expect(await listener.result).toContain("error=access_denied");
  await listener.close();
});

it("closes a native listener that becomes ready after cancellation", async () => {
  let announceReady!: () => void;
  let bound = false;
  let effectiveCloses = 0;
  const fakeServer = {
    on() {
      return this;
    },
    listen(_options: unknown, ready: () => void) {
      announceReady = () => {
        bound = true;
        ready();
      };
      return this;
    },
    address() {
      return bound ? { port: 1455 } : null;
    },
    close(callback?: () => void) {
      if (bound) {
        effectiveCloses++;
        bound = false;
      }
      callback?.();
      return this;
    },
  };
  const controller = new AbortController();
  const start = startLoopback(
    { createServer: () => fakeServer },
    { state: "state", signal: controller.signal },
  );
  const rejected = expect(start).rejects.toMatchObject({ code: "cancelled" });
  controller.abort();
  await rejected;
  announceReady();
  await Promise.resolve();
  expect(effectiveCloses).toBe(1);
  expect(bound).toBe(false);
});
