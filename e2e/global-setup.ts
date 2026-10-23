import { execFileSync } from "node:child_process";

/**
 * Empties the E2E Neon branch before the suite, so a pass never depends on earlier state.
 *
 * Runs here rather than in the web server command because this process still sees the real
 * DATABASE_URL, which the reset script needs in order to refuse to touch it.
 */
export default function globalSetup(): void {
  execFileSync(process.execPath, ["scripts/db-setup.mjs", "--test", "--reset"], {
    stdio: "inherit",
  });
}
