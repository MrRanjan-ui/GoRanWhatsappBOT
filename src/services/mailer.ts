import { Resend } from 'resend';
import * as dotenv from 'dotenv';

// Ensure env variables are configured
dotenv.config();

const resendApiKey = process.env.RESEND_API_KEY || '';
const senderEmail = process.env.SENDER_EMAIL || 'Ashish Ranjan <ashish@goran.in>';
const notificationEmail = process.env.NOTIFICATION_EMAIL || 'goran.dotin@gmail.com';

// Initialize Resend client
const resend = resendApiKey ? new Resend(resendApiKey) : null;

export interface SendLeadEmailParams {
  phone: string;
  bizType: string;
  challenge: string;
  process: string;
  teamSize: string;
  email: string;
  score: string;
  scoreReason: string;
  summaryBlock: string;
  meetingTime?: string;
  meetingLink?: string;
  meetingStartIso?: string;
  meetingEndIso?: string;
}

/**
 * Sends HTML emails to the agency (lead alert) and prospect (recap summary) using Resend.
 */
export async function sendLeadEmails(params: SendLeadEmailParams) {
  // Skip if Resend API key is not configured
  if (!resend) {
    console.warn('[MAIL-SERVICE] Resend API key is not configured. Skipping email notifications.');
    return;
  }

  // 1. Email to Agency Inbox (Lead alert)
  const agencyMailOptions = {
    from: senderEmail,
    to: notificationEmail,
    subject: `🔥 New Qualified Lead: ${params.bizType} (${params.score})`,
    text: `New Qualified Lead Details:\n\n` +
          `Phone Number: +${params.phone}\n` +
          `Contact Email: ${params.email}\n` +
          `Business Type: ${params.bizType}\n` +
          `Biggest Challenge: ${params.challenge}\n` +
          `Current Workflow: ${params.process}\n` +
          `Team Size: ${params.teamSize} employees\n` +
          `AI Lead Scoring: ${params.score}\n` +
          `Reason: ${params.scoreReason}\n\n` +
          `Summary Block:\n${params.summaryBlock}\n\n` +
          (params.meetingTime ? `Scoping Call Confirmed: ${params.meetingTime}\nLink: ${params.meetingLink}` : `Scoping Call Scheduled: No`),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; padding: 20px; border-radius: 8px;">
        <h2 style="color: #F6C744; border-bottom: 2px solid #F6C744; padding-bottom: 8px;">New Qualified Lead Details</h2>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 6px 0; font-weight: bold; width: 35%;">Phone Number JID:</td>
            <td style="padding: 6px 0;">+${params.phone}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-weight: bold;">Contact Email:</td>
            <td style="padding: 6px 0;"><a href="mailto:${params.email}">${params.email}</a></td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-weight: bold;">Business Type:</td>
            <td style="padding: 6px 0;">${params.bizType}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-weight: bold;">Biggest Challenge:</td>
            <td style="padding: 6px 0;">${params.challenge}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-weight: bold;">Current Workflow:</td>
            <td style="padding: 6px 0;">${params.process}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-weight: bold;">Team Size:</td>
            <td style="padding: 6px 0;">${params.teamSize} employees</td>
          </tr>
        </table>
        
        <div style="background-color: #f9f9f9; padding: 15px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #F6C744;">
          <h3 style="margin-top: 0; color: #333;">AI Lead Scoring: <span style="color: #e67e22; font-weight: bold;">${params.score}</span></h3>
          <p style="margin-bottom: 0;"><strong>Reason:</strong> ${params.scoreReason}</p>
        </div>

        <h3>Structured Summary Block:</h3>
        <pre style="background: #2d3748; color: #fff; padding: 15px; border-radius: 6px; font-family: monospace; white-space: pre-wrap; font-size: 13px; line-height: 1.4;">${params.summaryBlock}</pre>

        <div style="margin-top: 20px; font-size: 14px;">
          ${params.meetingTime ? 
            `<p style="background-color: #d4edda; color: #155724; padding: 12px; border-radius: 6px; border: 1px solid #c3e6cb;">
              📅 <strong>Scoping Call Scheduled!</strong><br />
              Time: <strong>${params.meetingTime}</strong><br />
              <a href="${params.meetingLink}" style="color: #155724; font-weight: bold; text-decoration: underline;">View on Google Calendar</a>
             </p>` : 
            `<p style="background-color: #fff3cd; color: #856404; padding: 12px; border-radius: 6px; border: 1px solid #ffeeba;">
              📅 <strong>Scoping Call Scheduled:</strong> No (Client skipped/deferred)
             </p>`
          }
        </div>
      </div>
    `
  };

  // 2. Email to Prospect (Client follow-up recap)
  const clientMailOptions: any = {
    from: senderEmail,
    to: params.email,
    subject: params.meetingTime
      ? `Confirmed: GoRan AI Strategy Call - ${params.meetingTime}`
      : `Recap: GoRan AI Scoping Session & Automation Opportunities`,
    text: `Hi,\n\n` +
          `Thanks for taking a few minutes to share details about your business with the GoRan AI assistant today! I've reviewed your inputs and put together a few preliminary thoughts for your business: ${params.bizType}.\n\n` +
          `AI Opportunities Identified:\n` +
          `- Workflow Automation: Eliminating manual steps in your current process (${params.process})\n` +
          `- Lead Engagement: Deploying active WhatsApp/Email follow-up loops\n` +
          `- Autonomous Support: Streamlining inquiries into a unified dashboard\n\n` +
          (params.meetingTime 
            ? `Our 15-minute scoping call is confirmed for:\n${params.meetingTime} (IST)\n\nCalendar Link: ${params.meetingLink}` 
            : `Schedule a quick 15-minute scoping call here:\nhttps://www.goran.in/?book=true`) +
          `\n\nBest regards,\n\nAshish Ranjan\nFounder & AI Systems Architect, GoRan AI\nhttps://goran.in`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <p>Hi,</p>
        <p>Thanks for taking a few minutes to share details about your business with the GoRan AI assistant today! I've reviewed your inputs and put together a few preliminary thoughts for your business: <strong>${params.bizType}</strong>.</p>
        
        <h3 style="color: #F6C744; border-bottom: 1px solid #ddd; padding-bottom: 5px;">AI Opportunities Identified:</h3>
        <p>Based on your biggest operational challenge with <strong>${params.challenge}</strong>, here are a few immediate areas where custom AI agents can automate tasks for your team of ${params.teamSize} employees:</p>
        <ul>
          <li><strong>Workflow Automation</strong>: Eliminating manual steps in your current process (<em>${params.process}</em>) using secure database loops and API connections.</li>
          <li><strong>Lead Engagement</strong>: Deploying active WhatsApp/Email follow-up loops to prevent leads from slipping through the cracks.</li>
          <li><strong>Autonomous Support</strong>: Streamlining inquiries into a unified dashboard to save hours of manual coordination.</li>
        </ul>
        
        ${params.meetingTime ? `
        <div style="background-color: #e8f4fd; border: 1px solid #b8daff; padding: 15px; border-radius: 6px; margin: 20px 0;">
          <h4 style="margin-top: 0; color: #004085; font-size: 16px;">📅 Strategy Session Confirmed</h4>
          <p style="margin-bottom: 8px;">Our 15-minute scoping call is locked in for:</p>
          <p style="font-size: 18px; font-weight: bold; margin: 5px 0; color: #004085;">${params.meetingTime} (IST)</p>
          <p style="font-size: 13px; margin-bottom: 0; color: #666;">
            A calendar invitation (.ics) has been attached to this email. You can also view the event directly here: 
            <a href="${params.meetingLink}" style="color: #004085; font-weight: bold; text-decoration: underline;">Open Calendar Link</a>
          </p>
        </div>
        ` : `
        <div style="background-color: #fff3cd; border: 1px solid #ffeeba; padding: 15px; border-radius: 6px; margin: 20px 0;">
          <h4 style="margin-top: 0; color: #856404; font-size: 16px;">📅 Book Your Strategy Session</h4>
          <p style="margin-bottom: 8px;">If you haven't booked a slot yet, a quick 15-minute call is the fastest way to map out an implementation roadmap for your business.</p>
          <a href="https://www.goran.in/?book=true" style="display: inline-block; background-color: #F6C744; color: #111; padding: 10px 20px; text-decoration: none; font-weight: bold; border-radius: 6px; margin-top: 5px;">Schedule Call Now</a>
        </div>
        `}
        
        <p>I look forward to discussing how we can save your team hours of manual effort.</p>
        
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="font-size: 14px; margin-bottom: 0;">
          Best regards,<br /><br />
          <strong>Ashish Ranjan</strong><br />
          Founder & AI Systems Architect, GoRan AI<br />
          <a href="https://goran.in" style="color: #F6C744; text-decoration: none;">goran.in</a>
        </p>
      </div>
    `
  };

  if (params.meetingStartIso && params.meetingEndIso) {
    try {
      const startDate = new Date(params.meetingStartIso);
      const endDate = new Date(params.meetingEndIso);
      
      const formatUTCDateTime = (date: Date): string => {
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        const seconds = String(date.getUTCSeconds()).padStart(2, '0');
        return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
      };

      const escapeICSValue = (val: string): string => {
        return val
          .replace(/\\/g, '\\\\')
          .replace(/;/g, '\\;')
          .replace(/,/g, '\\,')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '');
      };

      const uid = `goran-ai-${params.phone}-${startDate.getTime()}@goran.in`;
      const dtStamp = formatUTCDateTime(new Date());
      const dtStart = formatUTCDateTime(startDate);
      const dtEnd = formatUTCDateTime(endDate);
      
      const summary = escapeICSValue(`GoRan AI Strategy Call: ${params.bizType || 'Prospect'} & Ashish Ranjan`);
      const description = escapeICSValue(
        `Automated scoping session for GoRan AI.\n\n` +
        `Lead Details:\n` +
        `- Business Type: ${params.bizType || 'TBD'}\n` +
        `- Challenge: ${params.challenge || 'TBD'}\n` +
        `- Current Process: ${params.process || 'TBD'}\n` +
        `- Team Size: ${params.teamSize || 'TBD'}\n` +
        `- Phone: +${params.phone}\n` +
        `- Email: ${params.email || 'TBD'}` +
        (params.meetingLink ? `\n- Reference Link: ${params.meetingLink}` : '')
      );

      const icsContent = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//GoRan AI//Meeting Bot//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:REQUEST',
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${summary}`,
        `DESCRIPTION:${description}`,
        `ORGANIZER;CN="Ashish Ranjan":mailto:${senderEmail}`,
        `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="${params.email}":mailto:${params.email}`,
        'STATUS:CONFIRMED',
        'SEQUENCE:0',
        'END:VEVENT',
        'END:VCALENDAR'
      ].join('\r\n');

      clientMailOptions.attachments = [
        {
          filename: 'invite.ics',
          content: Buffer.from(icsContent)
        }
      ];
      console.log(`[MAIL-SERVICE] Generated .ics meeting invitation: UID=${uid}`);
    } catch (icsErr: any) {
      console.error('[MAIL-SERVICE] Failed to generate .ics string:', icsErr.message || icsErr);
    }
  }

  try {
    // Send agency notification
    const agencyResult = await resend.emails.send(agencyMailOptions);
    if (agencyResult.error) {
      console.error('[MAIL-SERVICE] Lead alert email dispatch failed:', agencyResult.error);
    } else {
      console.log(`[MAIL-SERVICE] Lead alert email dispatched to agency inbox: ${agencyResult.data?.id}`);
    }
    
    // Send client recap
    if (params.email && params.email.includes('@')) {
      const clientResult = await resend.emails.send(clientMailOptions);
      if (clientResult.error) {
        console.error('[MAIL-SERVICE] Opportunity recap email dispatch failed:', clientResult.error);
      } else {
        console.log(`[MAIL-SERVICE] Opportunity recap email dispatched to prospect: ${clientResult.data?.id}`);
      }
    }
  } catch (error: any) {
    console.error('[MAIL-SERVICE] Email dispatch failed:', error.message || error);
  }
}
