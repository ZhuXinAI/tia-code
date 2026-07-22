import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(scriptsDirectory, "..", "dist");

await rm(outputDirectory, { recursive: true, force: true });
