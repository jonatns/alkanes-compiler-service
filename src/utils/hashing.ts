import crypto from "crypto";

export function stableHash(source: string): string {
  // Normalize text for deterministic hashing
  const normalized = source
    .replace(/\r\n/g, "\n") // Normalize CRLF to LF
    .replace(/[ \t]+$/gm, "") // Strip trailing spaces/tabs per line
    .replace(/\n{2,}/g, "\n") // Collapse multiple blank lines
    .trim(); // Remove leading/trailing blank lines

  return crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);
}
