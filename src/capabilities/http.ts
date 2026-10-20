import { bounded, check, fail, CapabilityError } from "./contracts";

export function https(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail("validation", "Invalid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    fail("permission", "Only credential-free HTTPS URLs are allowed");
  // Do not expose the device's loopback/LAN through model-selected URLs.
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.includes(":") ||
    /^[\d.]+$/.test(host) ||
    !host.includes(".")
  )
    fail("permission", "Local network addresses are unavailable");
  url.hash = "";
  return url;
}
export async function download(
  input: string,
  fetcher: typeof fetch,
  authorize: (origin: string, signal: AbortSignal) => Promise<void>,
  parent: AbortSignal,
  maxBytes: number,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(abort, 30000);
  const signal = controller.signal;
  try {
    let url = https(input);
    for (let hop = 0; hop < 6; hop++) {
      check(signal);
      await authorize(url.origin, signal);
      check(signal);
      const response = await fetcher(url.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal,
        headers: {
          Accept: "application/json, text/plain, text/markdown, text/html",
        },
      });
      check(signal);
      // Fail closed if the native transport followed a redirect despite manual mode.
      if (
        (response.redirected &&
          ![301, 302, 303, 307, 308].includes(response.status)) ||
        (response.url && response.url !== url.href)
      ) {
        await response.body?.cancel();
        fail("transport", "Transport did not honor manual redirects");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) fail("transport", "Redirect has no location");
        url = https(new URL(location!, url).href);
        continue;
      }
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "last-modified"]) {
        const value = response.headers.get(name);
        if (value) headers[name] = bounded(value, 1024);
      }
      if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
        await response.body?.cancel();
        fail("limit", "HTTP body is too large");
      }
      // Streaming is required: response.text() cannot enforce a memory bound.
      if (!response.body?.getReader)
        fail("transport", "Streaming HTTP response unavailable");
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "",
        size = 0;
      try {
        while (true) {
          check(signal);
          const part = await reader.read();
          check(signal);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > maxBytes) fail("limit", "HTTP body is too large");
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return { status: response.status, headers, text, bytes: size };
    }
    return fail("transport", "Too many redirects");
  } catch (error) {
    if (signal.aborted)
      fail(
        parent.aborted ? "cancelled" : "transport",
        parent.aborted ? "Operation cancelled" : "HTTP request timed out",
      );
    if (error instanceof CapabilityError) throw error;
    return fail("transport", "HTTP request failed");
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", abort);
  }
}
