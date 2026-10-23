import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SMTPServer } from "smtp-server";
import { MAIL_SINK_PORT, MAILBOX_DIR } from "./mailbox";

/**
 * Empties the E2E Neon branch before the suite, so a pass never depends on earlier state,
 * and starts the SMTP sink the test server mails through. Returns the sink's teardown.
 *
 * Runs here rather than in the web server command because this process still sees the real
 * DATABASE_URL, which the reset script needs in order to refuse to touch it.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  execFileSync(process.execPath, ["scripts/db-setup.mjs", "--test", "--reset"], {
    stdio: "inherit",
  });

  rmSync(MAILBOX_DIR, { recursive: true, force: true });
  mkdirSync(MAILBOX_DIR, { recursive: true });
  let received = 0;
  const sink = new SMTPServer({
    logger: false,
    authOptional: true,
    disabledCommands: ["STARTTLS", "AUTH"],
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        received += 1;
        const file = `${Date.now()}-${String(received).padStart(5, "0")}.json`;
        writeFileSync(
          path.join(MAILBOX_DIR, file),
          JSON.stringify({
            to: session.envelope.rcptTo.map((rcpt) => rcpt.address.toLowerCase()),
            raw: Buffer.concat(chunks).toString("utf8"),
          })
        );
        callback();
      });
    },
  });
  await new Promise<void>((resolve, reject) => {
    sink.server.once("error", reject);
    sink.listen(MAIL_SINK_PORT, "127.0.0.1", () => resolve());
  });

  return () => new Promise<void>((resolve) => sink.close(() => resolve()));
}
