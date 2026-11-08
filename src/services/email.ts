/**
 * Email Service using Mailgun API
 *
 * This module provides email sending functionality for:
 * - Invitation emails
 * - Notification emails
 */

import { serverT } from '../utils/i18n'

export interface SendEmailParams {
  to: string
  subject: string
  html: string
  from?: string
}

export interface MailgunConfig {
  apiKey: string
  domain: string
}

/**
 * Send an email using Mailgun API
 */
export async function sendEmail(
  config: MailgunConfig,
  params: SendEmailParams
): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    // Mailgun API endpoint
    const url = `https://api.mailgun.net/v3/${config.domain}/messages`

    // Parse from address
    const fromEmail = params.from?.match(/<(.+)>/)?.[1] || params.from || `noreply@${config.domain}`
    const fromName = params.from?.match(/(.+)\s*</)?.[1]?.trim() || 'Zeeta'
    const fromAddress = `${fromName} <${fromEmail}>`

    // Mailgun uses form-encoded data
    const formData = new URLSearchParams()
    formData.append('from', fromAddress)
    formData.append('to', params.to)
    formData.append('subject', params.subject)
    formData.append('html', params.html)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`api:${config.apiKey}`),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    })

    // Mailgun returns 200 OK on success
    if (response.ok) {
      const data = await response.json().catch(() => ({}))
      return {
        success: true,
        id: data.id
      }
    }

    const data = await response.json().catch(() => ({}))
    console.error('Failed to send email:', data)
    return {
      success: false,
      error: data.message || 'Failed to send email'
    }
  } catch (error) {
    console.error('Email sending error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Generate invitation email HTML
 */
export function generateInvitationEmailHtml(params: {
  inviterName: string
  treeName: string
  role: string
  acceptUrl: string
  expiresAt: string
}): string {
  const dateTimeFormatOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }
  const expiresDateJa = new Date(params.expiresAt).toLocaleDateString('ja-JP', dateTimeFormatOptions)
  const expiresDateEn = new Date(params.expiresAt).toLocaleDateString('en-US', dateTimeFormatOptions)

  const roleKey = params.role === 'editor' ? 'email.roleEditor' : 'email.roleViewer'
  const roleTextJa = serverT('ja', roleKey)
  const roleTextEn = serverT('en', roleKey)

  return `
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${serverT('ja', 'email.title')} / ${serverT('en', 'email.title')}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 40px 0;">
        <table role="presentation" style="width: 600px; max-width: 90%; background-color: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; color: white; font-size: 28px; font-weight: 600;">Zeeta</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <div lang="ja">
                <h2 style="margin: 0 0 20px; color: #333; font-size: 24px; font-weight: 600;">${serverT('ja', 'email.heading')}</h2>

                <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
                  <strong>${params.inviterName}</strong>${serverT('ja', 'email.invitationAfterInviter')}<strong>${params.treeName}</strong>${serverT('ja', 'email.invitationAfterTree')}
                </p>

                <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                  <tr>
                    <td style="padding: 12px; background-color: #f8f9fa; border-radius: 4px;">
                      <p style="margin: 0; color: #666; font-size: 14px;">
                        <strong>${serverT('ja', 'email.roleLabel')}:</strong> ${roleTextJa}
                      </p>
                      <p style="margin: 8px 0 0; color: #666; font-size: 14px;">
                        <strong>${serverT('ja', 'email.expiresLabel')}:</strong> ${expiresDateJa}
                      </p>
                    </td>
                  </tr>
                </table>
              </div>

              <hr style="margin: 30px 0; border: 0; border-top: 1px solid #e5e7eb;">

              <div lang="en">
                <h2 style="margin: 0 0 20px; color: #333; font-size: 24px; font-weight: 600;">${serverT('en', 'email.heading')}</h2>

                <p style="margin: 0 0 20px; color: #666; font-size: 16px; line-height: 1.6;">
                  <strong>${params.inviterName}</strong>${serverT('en', 'email.invitationAfterInviter')}<strong>${params.treeName}</strong>${serverT('en', 'email.invitationAfterTree')}
                </p>

                <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                  <tr>
                    <td style="padding: 12px; background-color: #f8f9fa; border-radius: 4px;">
                      <p style="margin: 0; color: #666; font-size: 14px;">
                        <strong>${serverT('en', 'email.roleLabel')}:</strong> ${roleTextEn}
                      </p>
                      <p style="margin: 8px 0 0; color: #666; font-size: 14px;">
                        <strong>${serverT('en', 'email.expiresLabel')}:</strong> ${expiresDateEn}
                      </p>
                    </td>
                  </tr>
                </table>
              </div>

              <!-- CTA Button -->
              <table role="presentation" style="margin: 30px 0;">
                <tr>
                  <td style="text-align: center;">
                    <a href="${params.acceptUrl}"
                       style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                      <span lang="ja">${serverT('ja', 'email.acceptButton')}</span> / <span lang="en">${serverT('en', 'email.acceptButton')}</span>
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 20px 0 0; color: #999; font-size: 14px; line-height: 1.6;">
                <span lang="ja">${serverT('ja', 'email.linkInstructions')}</span><br>
                <span lang="en">${serverT('en', 'email.linkInstructions')}</span><br>
                <a href="${params.acceptUrl}" style="color: #667eea; word-break: break-all;">${params.acceptUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px; background-color: #f8f9fa; border-radius: 0 0 8px 8px; text-align: center;">
              <p lang="ja" style="margin: 0; color: #999; font-size: 12px;">
                ${serverT('ja', 'email.ignoreNotice')}
              </p>
              <p lang="en" style="margin: 8px 0 0; color: #999; font-size: 12px;">
                ${serverT('en', 'email.ignoreNotice')}
              </p>
              <p style="margin: 10px 0 0; color: #999; font-size: 12px;">
                © ${new Date().getFullYear()} Zeeta. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`
}

export function generateInvitationEmailSubject(treeName: string): string {
  return `${serverT('ja', 'email.subject', { treeName })} / ${serverT('en', 'email.subject', { treeName })}`
}

/**
 * Send invitation email
 */
export async function sendInvitationEmail(
  config: MailgunConfig,
  params: {
    to: string
    inviterName: string
    treeName: string
    role: 'editor' | 'viewer'
    token: string
    appUrl: string
    expiresAt: string
  }
): Promise<{ success: boolean; error?: string }> {
  const acceptUrl = `${params.appUrl}/accept-invitation.html?token=${params.token}`

  const html = generateInvitationEmailHtml({
    inviterName: params.inviterName,
    treeName: params.treeName,
    role: params.role,
    acceptUrl,
    expiresAt: params.expiresAt
  })

  return await sendEmail(config, {
    to: params.to,
    subject: generateInvitationEmailSubject(params.treeName),
    html
  })
}
