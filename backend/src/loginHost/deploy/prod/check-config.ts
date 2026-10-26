/**
 * ENG-2110: the host's OWN config parser as a tiny stand-alone checker. build-login-host.sh bundles this file to check-config.js; install.sh runs it on the
 * generated config before the host ever reads it, so a config the host would refuse never replaces a working one.
 *
 *   node check-config.js <config.json>      exit 0 and "config ok", or exit 1 and the schema message (never a secret: the config holds none)
 */
import { readFileSync } from "fs";
import { parseHostConfig } from "../../host/hostConfig";

try {
  parseHostConfig(JSON.parse(readFileSync(process.argv[2], "utf8")));
  console.log("config ok");
} catch (e) {
  console.error(String((e as Error).message));
  process.exit(1);
}
