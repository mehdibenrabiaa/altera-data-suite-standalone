// Uploads whatever `npm run dist:win` produced in release/ (the NSIS
// installer, latest.yml, and the installer's own .exe.blockmap) to
// altera-license-server's /admin/updates/publish -- electron-updater's
// "generic" provider (see package.json's build.publish) then reads them
// back from there on every user's next launch.
//
// Run: npm run dist:win && ALTERA_ADMIN_SECRET=... npm run publish:update
//
// ALTERA_ADMIN_SECRET is read from the environment on purpose -- never
// hardcode it here or pass it on the command line where shell history
// would keep it.

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RELEASE_DIR = join(__dirname, "..", "release");
const SERVER = process.env.ALTERA_UPDATE_SERVER ?? "https://backend.alteradatasuite.com";
const ADMIN_SECRET = process.env.ALTERA_ADMIN_SECRET;

if (!ADMIN_SECRET) {
  console.error("Set ALTERA_ADMIN_SECRET in your environment before running this.");
  process.exit(1);
}

let entries;
try {
  entries = readdirSync(RELEASE_DIR);
} catch {
  console.error(`Couldn't read ${RELEASE_DIR} -- run "npm run dist:win" first.`);
  process.exit(1);
}

const files = entries.filter((f) => f.endsWith(".exe") || f.endsWith(".yml") || f.endsWith(".blockmap"));
if (files.length === 0) {
  console.error(`No installer/.yml/.blockmap files found in ${RELEASE_DIR}.`);
  process.exit(1);
}

const form = new FormData();
for (const f of files) {
  form.append("files", new Blob([readFileSync(join(RELEASE_DIR, f))]), f);
}

const res = await fetch(`${SERVER}/admin/updates/publish`, {
  method: "POST",
  headers: { "x-api-key": ADMIN_SECRET },
  body: form,
});
const body = await res.json().catch(() => null);

if (!res.ok) {
  console.error("Publish failed:", res.status, body);
  process.exit(1);
}

console.log("Published:", body.files);
