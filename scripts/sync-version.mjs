// Runs during `npm version`: copies the new package.json version into the other manifests.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const update = (file, apply) => {
  const json = JSON.parse(readFileSync(file, "utf8"));
  apply(json);
  writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
};
update("plugin.json", (j) => (j.version = version));
update("server.json", (j) => {
  j.version = version;
  for (const p of j.packages ?? []) p.version = version;
});
update("mcpb/manifest.json", (j) => (j.version = version));
console.log(`Synced version ${version} into plugin.json, server.json, mcpb/manifest.json`);
