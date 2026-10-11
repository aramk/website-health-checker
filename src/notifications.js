import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

import { updateSiteLastNotifiedAt } from './db.js';

const rootDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TEMPLATE_PATH = join(rootDir, '..', 'templates', 'website-down-email.html');

function normalizeRecipients(recipients) {
  return Array.isArray(recipients)
    ? recipients.filter((recipient) => typeof recipient === 'string' && recipient.trim()).map((recipient) => recipient.trim())
    : [];
}

async function renderHtmlTemplate({ templatePath, subject, dashboardUrl, failingSites }) {
  const resolvedPath = templatePath ? templatePath : DEFAULT_TEMPLATE_PATH;
  let template = '';
  try {
    template = await readFile(resolvedPath, 'utf8');
  } catch {
    template = `<!DOCTYPE html><html><body><h1>{{subject}}</h1><p>{{dashboardUrl}}</p><ul>{{#each failingSites}}<li>{{name}} — {{url}}</li>{{/each}}</ul></body></html>`;
  }

  const rows = failingSites
    .map(
      (site) => `
        <tr>
          <td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
            <strong>${String(site.name ?? 'Unknown site')}</strong><br />
            <a href="${String(site.url ?? '#')}" style="color: #2563eb; text-decoration: none;">${String(site.url ?? '')}</a><br />
            <span style="color: #6b7280;">Last checked: ${new Date(site.checked_at ?? Date.now()).toISOString()}</span>
          </td>
        </tr>`
    )
    .join('');

  return template
    .replace(/{{subject}}/g, subject)
    .replace(/{{dashboardUrl}}/g, dashboardUrl)
    .replace(/{{#each failingSites}}[\s\S]*?{{\/each}}/g, rows);
}

export async function sendNotificationEmail({ config, failingSites, subject, dashboardUrl }) {
  if (!config?.enabled || !config.mailUrl) {
    return { sent: false, reason: 'notification email disabled or no mailUrl configured' };
  }

  const recipients = normalizeRecipients(config.recipients);
  if (!recipients.length) {
    return { sent: false, reason: 'notification email has no recipients configured' };
  }

  let mailTransport;
  try {
    mailTransport = nodemailer.createTransport(config.mailUrl);
  } catch (err) {
    console.error('[mail] invalid mailUrl; unable to create SMTP transport:', err instanceof Error ? err.message : String(err));
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }

  const html = await renderHtmlTemplate({
    templatePath: config.htmlTemplatePath ? join(process.cwd(), config.htmlTemplatePath) : DEFAULT_TEMPLATE_PATH,
    subject,
    dashboardUrl,
    failingSites,
  });

  const siteNames = failingSites.map((site) => site.name || site.url).join(', ');
  console.log(`[mail] preparing to send downtime email to ${recipients.length} recipient(s) for ${failingSites.length} site(s): ${siteNames}`);

  try {
    const info = await mailTransport.sendMail({
      from: config.from || 'Website Health Alerts <alerts@example.com>',
      to: recipients,
      subject,
      html,
    });

    console.log(`[mail] email sent successfully to ${recipients.length} recipient(s); messageId=${info.messageId || 'unknown'}`);
    return { sent: true, messageId: info.messageId || null };
  } catch (err) {
    console.error('[mail] failed to send notification email:', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(err.stack);
    return { sent: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function notifyFailingSites({ notifications, failingSites, now }) {
  if (!Array.isArray(failingSites) || !failingSites.length) return [];
  const emailCfg = notifications?.email;
  if (!emailCfg?.enabled) return [];

  const notifyEveryMs = Math.max(1, Number(emailCfg.notifyEverySec ?? 3600)) * 1000;
  const eligible = failingSites.filter((site) => {
    if (!site.last_notified_at) return true;
    const lastNotifiedAt = new Date(site.last_notified_at).getTime();
    return Number.isFinite(lastNotifiedAt) ? now - lastNotifiedAt >= notifyEveryMs : true;
  });

  if (!eligible.length) return [];

  const dashboardUrl = emailCfg.rootUrl || 'http://localhost:3000';
  const subject = eligible.length > 1 ? 'Website Health Alert: Multiple sites are down' : `Website Health Alert: ${eligible[0].name} is down`;

  const eligibleNames = eligible.map((site) => site.name || site.url).join(', ');
  console.log(`[mail] ${eligible.length} down site(s) eligible for notification (${eligibleNames}); checking cooldown window (${emailCfg.notifyEverySec ?? 3600}s)`);

  try {
    const result = await sendNotificationEmail({
      config: emailCfg,
      failingSites: eligible,
      subject,
      dashboardUrl,
    });

    if (result.sent) {
      for (const site of eligible) {
        updateSiteLastNotifiedAt(site.id, new Date(now).toISOString());
      }
    }

    return eligible;
  } catch (err) {
    console.error('[mail] unexpected notification error:', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(err.stack);
    return [];
  }

  if (result.sent) {
    for (const site of eligible) {
      updateSiteLastNotifiedAt(site.id, new Date(now).toISOString());
    }
  }

  return eligible;
}
