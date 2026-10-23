import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { MailConfigError, readMailConfig, sendMail, type MailMessage } from "@/lib/server/mailer";

const MESSAGE: MailMessage = {
  to: "guest@krave.test",
  subject: "Reset your KRAVE password",
  text: "plain body",
  html: "<p>html body</p>",
};

interface Received {
  from: string;
  to: string[];
  raw: string;
}

const servers: SMTPServer[] = [];

/** A real SMTP server on a free port, recording what reaches it. */
async function startServer(options: SMTPServerOptions) {
  const received: Received[] = [];
  const logins: string[] = [];
  const server = new SMTPServer({
    logger: false,
    ...options,
    onAuth(auth, _session, callback) {
      logins.push(auth.username ?? "");
      callback(null, { user: auth.username });
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
          raw: Buffer.concat(chunks).toString("utf8"),
        });
        callback();
      });
    },
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.server.address() as AddressInfo;
  return { port, received, logins };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe("readMailConfig", () => {
  it("is off without a host, so a deployment without email is not an error", () => {
    expect(readMailConfig({})).toBeNull();
    expect(readMailConfig({ SMTP_HOST: "  " })).toBeNull();
  });

  it("uses STARTTLS on 587 and implicit TLS on 465, and insists on TLS before a login", () => {
    const starttls = readMailConfig({ SMTP_HOST: "smtp.example.test", SMTP_USER: "u@x.test", SMTP_PASS: "p" });
    expect(starttls).toMatchObject({ port: 587, secure: false, requireTLS: true });

    const implicit = readMailConfig({
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "465",
      SMTP_USER: "u@x.test",
      SMTP_PASS: "p",
    });
    expect(implicit).toMatchObject({ port: 465, secure: true, requireTLS: false });
  });

  it("sends as KRAVE from the login address unless EMAIL_FROM says otherwise", () => {
    const login = { SMTP_HOST: "smtp.example.test", SMTP_USER: "me@x.test", SMTP_PASS: "p" };
    expect(readMailConfig(login)?.from).toEqual({ name: "KRAVE", address: "me@x.test" });
    expect(readMailConfig({ ...login, EMAIL_FROM: "Ops <ops@x.test>" })?.from).toBe("Ops <ops@x.test>");
  });

  it.each([
    ["a port that is not a number", { SMTP_PORT: "smtp" }],
    ["port zero", { SMTP_PORT: "0" }],
    ["a port past the range", { SMTP_PORT: "65536" }],
    ["a fractional port", { SMTP_PORT: "587.5" }],
    ["a login without a password", { SMTP_USER: "u@x.test" }],
    ["a password without a login", { SMTP_PASS: "p" }],
    ["no login and no sender", {}],
  ])("refuses %s rather than half-working", (_label, extra) => {
    expect(() => readMailConfig({ SMTP_HOST: "smtp.example.test", ...extra })).toThrow(MailConfigError);
  });
});

describe("sendMail over real SMTP", () => {
  it("delivers the message to the recipient with the configured sender", async () => {
    const sink = await startServer({ disabledCommands: ["STARTTLS", "AUTH"], authOptional: true });
    const config = readMailConfig({
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(sink.port),
      EMAIL_FROM: "KRAVE <no-reply@krave.test>",
    });

    await sendMail(MESSAGE, config);

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].to).toEqual(["guest@krave.test"]);
    expect(sink.received[0].from).toBe("no-reply@krave.test");
    expect(sink.received[0].raw).toContain("Subject: Reset your KRAVE password");
  });

  it("never sends a login to a server that cannot encrypt the connection", async () => {
    // The server would accept a clear-text login; the client must refuse to offer one.
    const server = await startServer({ disabledCommands: ["STARTTLS"], allowInsecureAuth: true });
    const config = readMailConfig({
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(server.port),
      SMTP_USER: "me@krave.test",
      SMTP_PASS: "app-password",
    });

    await expect(sendMail(MESSAGE, config)).rejects.toThrow();
    expect(server.logins).toEqual([]);
    expect(server.received).toEqual([]);
  });

  it("fails loudly when email is not configured at all", async () => {
    await expect(sendMail(MESSAGE, null)).rejects.toThrow(MailConfigError);
  });
});
