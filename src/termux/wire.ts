import { FileError, ExecutionError } from "@earendil-works/pi-durable/env";
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export function unhex(value: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error("Invalid hex");
  return Uint8Array.from(value.match(/../g)!, (n) => parseInt(n, 16));
}
export function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Array.from(value) };
  if (value instanceof Error)
    return {
      $error: value instanceof ExecutionError ? "execution" : "file",
      code: (value as FileError).code,
      message: value.message,
      path: (value as FileError).path,
      spillPath: (value as ExecutionError).spillPath,
    };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, encode(v)]),
    );
  return value;
}
export function decode(value: any): any {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if ("$bytes" in value) return Uint8Array.from(value.$bytes);
    if ("$error" in value) {
      const e =
        value.$error === "execution"
          ? new ExecutionError(value.code, value.message)
          : new FileError(value.code, value.message, value.path);
      if (value.spillPath) (e as ExecutionError).spillPath = value.spillPath;
      return e;
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, decode(v)]),
    );
  }
  return value;
}
export const fileMethods = [
  "absolutePath",
  "joinPath",
  "readTextFile",
  "readTextLines",
  "readBinaryFile",
  "writeFile",
  "appendFile",
  "truncateFile",
  "flushFile",
  "renameFile",
  "fileInfo",
  "listDir",
  "canonicalPath",
  "exists",
  "createDir",
  "remove",
  "createTempDir",
  "createTempFile",
] as const;
