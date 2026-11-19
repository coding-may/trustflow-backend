import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';
import { withRetry } from '../webhook/retry.helper';

export interface NotificationPreference {
  emailEnabled: boolean;
  pushEnabled: boolean;
  disputeAlerts: boolean;
  evidenceReminders: boolean;
  milestoneNotifications?: boolean;
}

export interface MilestoneNotificationData {
  gigId: string;
  gigTitle: string;
  creator: string;
  milestoneId: string;
  status: string;
  amountXLM?: string;
  message?: string;
}

export interface DisputeNotificationData {
  escrowId: string;
  depositor: string;
  beneficiary: string;
  amountXLM: string;
  reason?: string;
  disputedAt?: string;
  evidenceDeadline?: string;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly resendApiKey: string;
  private readonly resendApiUrl: string;
  private readonly pushServerKey: string;
  private readonly pushApiUrl: string;

  private preferences = new Map<string, NotificationPreference>();

  constructor() {
    this.resendApiKey = process.env.RESEND_API_KEY || '';
    this.resendApiUrl = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
    this.pushServerKey = process.env.PUSH_SERVER_KEY || '';
    this.pushApiUrl = process.env.PUSH_API_URL || 'https://fcm.googleapis.com/fcm/send';
  }

  /**
   * Get notification preferences for a user address
   */
  getPreferences(address: string): NotificationPreference {
    return (
      this.preferences.get(address) || {
        emailEnabled: true,
        pushEnabled: true,
        disputeAlerts: true,
        evidenceReminders: true,
        milestoneNotifications: true,
      }
    );
  }

  /**
   * Update notification preferences for a user address
   */
  updatePreferences(
    address: string,
    updates: Partial<NotificationPreference>,
  ): NotificationPreference {
    const current = this.getPreferences(address);
    const updated = { ...current, ...updates };
    this.preferences.set(address, updated);
    this.logger.log(`Updated notification preferences for ${address}`);
    return updated;
  }

  /**
   * Send dispute notification to both depositor and beneficiary
   */
  async notifyDisputeEscalation(data: DisputeNotificationData): Promise<{
    depositorNotified: boolean;
    beneficiaryNotified: boolean;
  }> {
    const results = await Promise.allSettled([
      this.notifyParty(data.depositor, data, 'depositor'),
      this.notifyParty(data.beneficiary, data, 'beneficiary'),
    ]);

    const depositorNotified =
      results[0].status === 'fulfilled' ? results[0].value : false;
    const beneficiaryNotified =
      results[1].status === 'fulfilled' ? results[1].value : false;

    this.logger.log(
      `Dispute escalation notifications for escrow ${data.escrowId}: ` +
        `depositor=${depositorNotified}, beneficiary=${beneficiaryNotified}`,
    );

    return { depositorNotified, beneficiaryNotified };
  }

  /**
   * Send evidence required notification with urgent deadline warning
   */
  async notifyEvidenceRequired(
    address: string,
    data: DisputeNotificationData,
  ): Promise<boolean> {
    const prefs = this.getPreferences(address);
    // Short-circuit before expensive body rendering if opted out (#932)
    if (!prefs.evidenceReminders || (!prefs.emailEnabled && !prefs.pushEnabled)) {
      this.logger.debug(`Evidence reminders or channels disabled for ${address}; skipping template rendering`);
      return false;
    }

    const subject = `URGENT: Evidence Required for Dispute ${data.escrowId}`;
    const body = this.buildEvidenceEmailBody(data, address === data.depositor ? 'depositor' : 'beneficiary');

    let notified = false;
    if (prefs.emailEnabled) {
      notified = await this.sendEmail(address, subject, body);
    }
    if (prefs.pushEnabled) {
      notified = (await this.sendPushNotification(address, subject, body)) || notified;
    }
    return notified;
  }

  /**
   * Notify a single party about a dispute event
   */
  private async notifyParty(
    address: string,
    data: DisputeNotificationData,
    role: 'depositor' | 'beneficiary',
  ): Promise<boolean> {
    const prefs = this.getPreferences(address);
    // Short-circuit before expensive body rendering if opted out (#932)
    if (!prefs.disputeAlerts || (!prefs.emailEnabled && !prefs.pushEnabled)) {
      this.logger.debug(`Dispute alerts or channels disabled for ${address}; skipping template rendering`);
      return false;
    }

    const subject = `Dispute Escalated: Escrow ${data.escrowId}`;
    const body = this.buildDisputeEmailBody(data, role);

    let notified = false;
    if (prefs.emailEnabled) {
      notified = await this.sendEmail(address, subject, body);
    }
    if (prefs.pushEnabled) {
      notified = (await this.sendPushNotification(address, subject, body)) || notified;
    }
    return notified;
  }

  /**
   * Send email via Resend API
   */
  private async sendEmail(to: string, subject: string, htmlBody: string): Promise<boolean> {
    if (!this.resendApiKey) {
      this.logger.warn('Resend API key not configured. Skipping email.');
      return false;
    }

    try {
      await withRetry(
        () =>
          this.sendResendRequest({
            from: process.env.EMAIL_FROM || 'noreply@trustflow.xyz',
            to,
            subject,
            html: htmlBody,
          }),
        3,
        500,
      );
      this.logger.log(`Email sent to ${to}: ${subject}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send email to ${to}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Send browser push notification via FCM
   */
  private async sendPushNotification(
    address: string,
    title: string,
    body: string,
  ): Promise<boolean> {
    if (!this.pushServerKey) {
      this.logger.warn('Push server key not configured. Skipping push notification.');
      return false;
    }

    try {
      await withRetry(
        () =>
          this.sendPushRequest({
            to: `/topics/user_${address}`,
            notification: {
              title,
              body: body.substring(0, 100),
              icon: '/icon-192x192.png',
              click_action: process.env.FRONTEND_URL || 'https://trustflow.xyz',
            },
            data: {
              type: 'dispute',
              timestamp: new Date().toISOString(),
            },
          }),
        2,
        300,
      );
      this.logger.log(`Push notification sent to ${address}: ${title}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send push notification to ${address}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Dispatch a milestone event notification, short-circuiting before payload
   * construction if the recipient opted out of milestone notifications (#932).
   */
  async notifyMilestoneEvent(
    address: string,
    data: MilestoneNotificationData,
  ): Promise<boolean> {
    const prefs = this.getPreferences(address);
    // Short-circuit first before building templates (#932)
    if (!prefs.milestoneNotifications || (!prefs.emailEnabled && !prefs.pushEnabled)) {
      this.logger.debug(`Milestone notifications or channels disabled for ${address}; skipping template rendering`);
      return false;
    }

    const subject = `Milestone Update: ${data.gigTitle}`;
    const body = this.buildMilestoneEmailBody(data);

    let notified = false;
    if (prefs.emailEnabled) {
      notified = await this.sendEmail(address, subject, body);
    }
    if (prefs.pushEnabled) {
      notified = (await this.sendPushNotification(address, subject, body)) || notified;
    }
    return notified;
  }

  /**
   * Build HTML email body for milestone updates
   */
  private buildMilestoneEmailBody(data: MilestoneNotificationData): string {
    return `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #27ae60;">Milestone Update</h2>
  <p>Hello,</p>
  <p>There is an update on your gig milestone:</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Gig</strong></td>
        <td style="padding: 8px; border: 1px solid #ddd;">${data.gigTitle}</td></tr>
    <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Milestone ID</strong></td>
        <td style="padding: 8px; border: 1px solid #ddd;">${data.milestoneId}</td></tr>
    <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Status</strong></td>
        <td style="padding: 8px; border: 1px solid #ddd;">${data.status}</td></tr>
  </table>
  ${data.message ? `<p>${data.message}</p>` : ''}
</body>
</html>`;
  }

  /**
   * Build HTML email body for dispute escalation
   */
  private buildDisputeEmailBody(
    data: DisputeNotificationData,
    role: 'depositor' | 'beneficiary',
  ): string {
    const roleLabel = role === 'depositor' ? 'Depositor' : 'Beneficiary';
    return `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #e74c3c;">Dispute Escalated</h2>
  <p>Hello ${roleLabel},</p>
  <p>A dispute has been raised for the following escrow:</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Escrow ID</strong></td>
        <td style="padding: 8px; border: 1px solid #ddd;">${data.escrowId}</td></tr>
    <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Amount</strong></td>
        <td style="padding: 8px; border: 1px solid #ddd;">${data.amountXLM} XLM</td></tr>
    <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Depositor</strong></td>
        <td style="padding: 8px; border: 1px solid #ddd;">${data.depositor}</td></tr>
    <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Beneficiary</strong></td>
        <td style="padding: 8px; border: 1px solid #ddd;">${data.beneficiary}</td></tr>
    ${data.reason ? `<tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Reason</strong></td>
        <td style="padding: 8px; border: 1px solid #ddd;">${data.reason}</td></tr>` : ''}
  </table>
  <p style="color: #e74c3c; font-weight: bold;">Action may be required to prevent default forfeiture.</p>
  <p><a href="${process.env.FRONTEND_URL || 'https://trustflow.xyz'}/disputes/${data.escrowId}"
        style="background: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
    View Dispute
  </a></p>
</body>
</html>`;
  }

  /**
   * Build HTML email body for evidence required
   */
  private buildEvidenceEmailBody(
    data: DisputeNotificationData,
    role: 'depositor' | 'beneficiary',
  ): string {
    const roleLabel = role === 'depositor' ? 'Depositor' : 'Beneficiary';
    return `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #e67e22;">Evidence Required — Deadline Approaching</h2>
  <p>Hello ${roleLabel},</p>
  <p>Evidence submission is required for the following disputed escrow:</p>
  <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Escrow ID</strong></td>
        <td style="padding: 8px; border: 1px solid #ddd;">${data.escrowId}</td></tr>
    <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Amount</strong></td>
        <td style="padding: 8px; border: 1px solid #ddd;">${data.amountXLM} XLM</td></tr>
    ${data.evidenceDeadline ? `<tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Evidence Deadline</strong></td>
        <td style="padding: 8px; border: 1px solid #ddd; color: #e74c3c; font-weight: bold;">${data.evidenceDeadline}</td></tr>` : ''}
  </table>
  <p style="color: #e74c3c; font-weight: bold;">
    Failure to submit evidence by the deadline will result in default forfeiture.
  </p>
  <p><a href="${process.env.FRONTEND_URL || 'https://trustflow.xyz'}/disputes/${data.escrowId}/evidence"
        style="background: #e67e22; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">
    Submit Evidence
  </a></p>
</body>
</html>`;
  }

  /**
   * Send request to Resend API
   */
  private sendResendRequest(payload: {
    from: string;
    to: string;
    subject: string;
    html: string;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const url = new URL(this.resendApiUrl);

      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.resendApiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Resend API returned ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Send request to FCM push notification API
   */
  private sendPushRequest(payload: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const url = new URL(this.pushApiUrl);

      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `key=${this.pushServerKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`FCM API returned ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
