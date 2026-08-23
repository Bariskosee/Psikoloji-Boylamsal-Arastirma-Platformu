import { Injectable, Logger } from "@nestjs/common";
import { createTransport, type Transporter } from "nodemailer";
import { loadEnv } from "../../config/env.js";

export interface OutboundMail {
  readonly to: string;
  readonly subject: string;
  /** Plain text only. See the note below on why there is no HTML body. */
  readonly text: string;
}

/**
 * Outbound email (PLAN.md Phase 12).
 *
 * The only thing this platform sends by email is a researcher password-reset
 * link. It deliberately does not send anything to participants: participant
 * contact happens through Web Push, and the platform holds no participant email
 * address at all (FR-08, AGENT.md §5). Adding an email channel to participants
 * would mean holding an identifier the whole pseudonymity design exists to
 * avoid.
 *
 * ── Why plain text and no HTML ──────────────────────────────────────────────
 * An HTML email is a rendering surface, and the one message this sends carries
 * an account-takeover link. Plain text cannot hide a different destination
 * behind display text, is not rewritten by mail clients, and is what a
 * suspicious recipient can actually read before clicking. There is nothing here
 * that formatting would make clearer.
 *
 * ── Why a missing SMTP host is not an error ─────────────────────────────────
 * A team piloting before institutional mail relaying is arranged still needs
 * the flow to work end to end. With no host the message is logged instead of
 * sent, which keeps the reset path testable and lets an administrator read the
 * link out of the log. Startup warns loudly, in the same way missing VAPID keys
 * do, so a deployment cannot believe it is sending mail while it is not.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;

  // Matches every other service in this application: the environment is read
  // once at construction rather than injected, so a service can be built in a
  // test without standing up a configuration module.
  private readonly env = loadEnv();

  constructor() {
    this.transporter =
      this.env.SMTP_HOST === ""
        ? null
        : createTransport({
            host: this.env.SMTP_HOST,
            port: this.env.SMTP_PORT,
            secure: this.env.SMTP_SECURE,
            ...(this.env.SMTP_USER === ""
              ? {}
              : { auth: { user: this.env.SMTP_USER, pass: this.env.SMTP_PASSWORD } }),
          });
  }

  /** True when a real transport is configured. Surfaced on the ops page. */
  get configured(): boolean {
    return this.transporter !== null;
  }

  /**
   * Send one message.
   *
   * ── Why a failure here is thrown rather than swallowed ──────────────────
   * The caller decides what a failure means, and for a password reset the
   * answer is subtle: the researcher must NOT be told whether the address
   * exists, so the controller answers identically either way — but the failure
   * still has to reach the log, or a broken relay would look exactly like a
   * researcher mistyping their address, forever.
   */
  async send(mail: OutboundMail): Promise<void> {
    if (this.transporter === null) {
      /**
       * Logged at warn, with the body.
       *
       * This is the one place in the system that deliberately logs a secret,
       * and it is the correct trade: without a transport the alternative is a
       * researcher permanently locked out. It happens only when SMTP is
       * unconfigured — which startup has already warned about — and the body
       * is a single-use link that expires in an hour.
       */
      this.logger.warn(
        `SMTP is not configured; mail NOT SENT. to=${mail.to} subject=${mail.subject}\n${mail.text}`,
      );
      return;
    }

    await this.transporter.sendMail({
      from: this.env.MAIL_FROM === "" ? this.env.SMTP_USER : this.env.MAIL_FROM,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    });
  }
}
