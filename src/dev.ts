import { build } from "esbuild";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outfile = join(__dirname, "..", ".dev", "index.mjs");

await build({
  entryPoints: [join(__dirname, "index.tsx")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  // Keep runtime dependencies as Node ESM imports. Pi includes optional and
  // native-adjacent resources that must be resolved from node_modules rather
  // than folded into this small development entry point.
  packages: "external",
  jsx: "automatic",
  jsxImportSource: "react",
  logLevel: "warning",
  ignoreAnnotations: true,
});

const args = process.argv.slice(2);
const childArgs = args[0] === "--" ? args.slice(1) : args;
const child = spawn("node", [outfile, ...childArgs], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
