/** CSP is the first parsed element, before any untrusted artifact markup.
 * Native WebView also disables JS, file access, storage and navigation.
 */
export function artifactPreview(
  text: string,
  mime: "text/html" | "text/plain",
) {
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${mime === "text/html" ? text : `<pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(text)}</pre>`}</body></html>`;
}
