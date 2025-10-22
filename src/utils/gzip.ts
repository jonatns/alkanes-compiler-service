import { promisify } from "node:util";
import { gzip as _gzip, InputType } from "node:zlib";

export async function gzipWasm(wasmBuffer: InputType) {
  const gzip = promisify(_gzip);
  return gzip(wasmBuffer, { level: 9 });
}
