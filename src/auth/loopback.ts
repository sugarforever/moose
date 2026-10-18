/** Small HTTP callback receiver over an injected native TCP binding. No Node runtime. */
import { browserCallbackCode, CodexAuthError } from "./codex";
export interface TcpSocket {
  on(
    event: "data",
    callback: (data: { toString(encoding: string): string } | string) => void,
  ): this;
  on(event: "error" | "close", callback: () => void): this;
  end(data?: string): void;
  destroy(): void;
}
export interface TcpServer {
  on(event: "error", callback: (error: Error) => void): this;
  listen(options: { port: number; host: string }, ready: () => void): this;
  address(): { port: number } | null;
  close(callback?: () => void): this;
}
export interface TcpFactory {
  createServer(callback: (socket: TcpSocket) => void): TcpServer;
}
export async function startLoopback(
  tcp: TcpFactory,
  options: {
    port?: number;
    state: string;
    signal: AbortSignal;
    timeoutMs?: number;
  },
): Promise<{ port: number; result: Promise<string>; close(): Promise<void> }> {
  const { signal, state } = options;
  if (signal.aborted) throw new CodexAuthError("cancelled", "登录已取消");
  let resolveResult!: (url: string) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // May reject while the caller is still awaiting listener readiness.
  void result.catch(() => {});
  const sockets = new Set<TcpSocket>();
  const idleTimers = new Map<TcpSocket, ReturnType<typeof setTimeout>>();
  let settled = false;
  let closed: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectReady!: (error: Error) => void;
  let ready = false;
  const response = (status: string) =>
    `HTTP/1.1 ${status}\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`;
  const server = tcp.createServer((socket) => {
    if (settled || sockets.size >= 8) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    idleTimers.set(
      socket,
      setTimeout(() => socket.destroy(), 5000),
    );
    let buffer = "";
    let handled = false;
    socket.on("close", () => {
      sockets.delete(socket);
      clearTimeout(idleTimers.get(socket));
      idleTimers.delete(socket);
    });
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      if (handled || settled) return;
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (buffer.length > 8192) {
        handled = true;
        socket.end(response("431 Request Header Fields Too Large"));
        return;
      }
      if (!buffer.includes("\r\n\r\n")) return;
      handled = true;
      const match = /^GET (\/[^\s]*) HTTP\/1\.[01]\r\n/.exec(buffer);
      if (!match) {
        socket.end(response("400 Bad Request"));
        return;
      }
      let url: URL;
      try {
        url = new URL(`http://localhost:1455${match[1]}`);
      } catch {
        socket.end(response("400 Bad Request"));
        return;
      }
      if (url.pathname !== "/auth/callback") {
        socket.end(response("404 Not Found"));
        return;
      }
      try {
        browserCallbackCode(url.toString(), state);
      } catch (error) {
        if (!(error instanceof CodexAuthError) || error.code !== "denied") {
          socket.end(response("400 Bad Request"));
          return;
        }
      }
      const page =
        '<!doctype html><meta name="viewport" content="width=device-width"><title>Moose</title><p>Authorization received. You can return to Moose.</p><a href="moose://auth/complete">Return to Moose</a>';
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${page.length}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; base-uri 'none'\r\nConnection: close\r\n\r\n${page}`,
      );
      // Preserve this response until the socket closes. The caller closes the server in finally.
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolveResult(url.toString());
    });
  });
  const close = () => {
    if (closed) return closed;
    if (!settled) {
      settled = true;
      rejectResult(new CodexAuthError("cancelled", "登录已取消"));
    }
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    for (const idle of idleTimers.values()) clearTimeout(idle);
    idleTimers.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    closed = new Promise<void>((resolve) => {
      try {
        server.close(resolve);
      } catch {
        resolve();
      }
    });
    return closed;
  };
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectResult(error);
    if (!ready) rejectReady(error);
    void close();
  };
  const onAbort = () => fail(new CodexAuthError("cancelled", "登录已取消"));
  const listening = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    server.on("error", () =>
      fail(
        new CodexAuthError(
          "unavailable",
          "无法监听本地 1455 端口，请重试或使用设备码登录",
        ),
      ),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => fail(new CodexAuthError("expired", "浏览器登录已超时，请重试")),
      options.timeoutMs ?? 300000,
    );
    try {
      server.listen({ port: options.port ?? 1455, host: "127.0.0.1" }, () => {
        ready = true;
        if (signal.aborted || settled) {
          reject(new CodexAuthError("cancelled", "登录已取消"));
          // Native close-before-ready cannot cancel an in-flight bind.
          // Retry the actual close now, even if earlier cleanup already resolved.
          closed = undefined;
          void close();
          return;
        }
        resolve();
      });
    } catch {
      fail(
        new CodexAuthError(
          "unavailable",
          "本地回调服务不可用，请重新编译原生客户端或使用设备码登录",
        ),
      );
    }
  });
  await listening;
  return {
    port: server.address()?.port ?? options.port ?? 1455,
    result,
    close,
  };
}
