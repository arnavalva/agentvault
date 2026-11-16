// Copies the IDL produced by `anchor build` into the dashboard app.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const src = "target/idl/agentvault.json";
const dest = "app/src/idl/agentvault.json";
if (!existsSync(src)) {
  console.error(`Missing ${src}. Run \`anchor build\` first.`);
  process.exit(1);
}
mkdirSync("app/src/idl", { recursive: true });
copyFileSync(src, dest);
console.log(`Copied ${src} -> ${dest}`);
