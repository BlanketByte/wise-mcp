import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package root (works from src/ under tsx and from dist/ when built or installed via npm). */
export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PUBLIC_DIR = path.join(ROOT, "public");

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string; homepage?: string };
export const VERSION = pkg.version;
export const WEBSITE = "https://blanketbyte.com";
export const REPO_URL = "https://github.com/BlanketByte/wise-mcp";
