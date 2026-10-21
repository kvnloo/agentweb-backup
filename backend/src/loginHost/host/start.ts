/** Process entry for the systemd unit: `node dist/loginHost/host/start.js <config.json>`. Kept apart from main.ts so importing main never starts a host. */
import { runMain } from "./main";

void runMain();
