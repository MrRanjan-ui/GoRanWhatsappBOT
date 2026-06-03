import { WASocket } from '@whiskeysockets/baileys';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { askGemini, GeminiMessage } from './gemini';
import { createCalendarEvent } from './services/calendar';
import { sendLeadEmails } from './services/mailer';
import { saveLead } from './services/db';

// Initialize dotenv immediately
dotenv.config();

// Load static texts
const configPath = path.join(__dirname, '../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Sessions state storage (In-memory)
interface Session {
  state: 'QUAL_BIZ_TYPE' | 'QUAL_CHALLENGE' | 'QUAL_PROCESS' | 'QUAL_TEAM_SIZE' | 'QUAL_EMAIL' | 'QUAL_MEETING' | 'AI_CHAT';
  history: GeminiMessage[];
  timeoutTimer?: NodeJS.Timeout;
  leadData: {
    phone: string;
    bizType?: string;
    challenge?: string;
    process?: string;
    teamSize?: string;
    email?: string;
    meetingTime?: string;
    meetingLink?: string;
    score?: string;
    scoreReason?: string;
    summaryBlock?: string;
    questionsAsked: string[];
    timestamp: string;
  };
}

const sessions: { [jid: string]: Session } = {};

/**
 * Main message handler mapping states and actions
 */
export async function handleIncomingMessage(sock: WASocket, remoteJid: string, senderNumber: string, messageText: string) {
  // 1. Strict Whitelist Filter
  const allowedString = process.env.ALLOWED_NUMBERS || '';
  const allowedNumbers = allowedString.split(',').map(n => n.trim());

  if (!allowedNumbers.includes(senderNumber)) {
    console.log(`[WHITELIST-BLOCKED] Ignored message from ${senderNumber}: "${messageText}" (Allowed: ${allowedString})`);
    return;
  }

  console.log(`[MESSAGE-RECEIVED] From: ${senderNumber} | JID: ${remoteJid} | Message: "${messageText}"`);

  const text = messageText.trim();
  const lowerText = text.toLowerCase();

  // Reset/Initialize Session
  const isNewSession = !sessions[remoteJid];
  if (isNewSession) {
    sessions[remoteJid] = {
      state: 'QUAL_BIZ_TYPE',
      history: [],
      leadData: {
        phone: senderNumber,
        questionsAsked: [],
        timestamp: new Date().toISOString()
      }
    };
  }

  const session = sessions[remoteJid];

  // Refresh the 15-minute inactivity timer
  refreshSessionTimeout(sock, remoteJid);

  // Global command to reset conversation
  if (lowerText === 'menu' || lowerText === 'exit' || lowerText === 'reset' || lowerText === 'home') {
    session.state = 'QUAL_BIZ_TYPE';
    session.history = [];
    session.leadData = {
      phone: senderNumber,
      questionsAsked: [],
      timestamp: new Date().toISOString()
    };
    refreshSessionTimeout(sock, remoteJid);
    const welcome = "Hi, thanks for reaching out to GoRan AI.\n\nBefore we talk, I'd love to understand your business.\n\n*Question 1*: What type of business do you run?";
    await sock.sendMessage(remoteJid, { text: welcome });
    return;
  }

  // If new session, send greeting and Pattern Interrupt immediately
  if (isNewSession) {
    const welcome = "Hi, thanks for reaching out to GoRan AI.\n\nBefore we talk, I'd love to understand your business.\n\n*Question 1*: What type of business do you run?";
    await sock.sendMessage(remoteJid, { text: welcome });
    return;
  }

  // Heuristic side-question handler during qualification
  if (session.state !== 'AI_CHAT' && isAskingQuestion(text)) {
    console.log(`[QUAL-QUESTION-INTERRUPT] User asked a question: "${text}" at state: ${session.state}`);
    session.leadData.questionsAsked.push(text);
    
    await sock.sendPresenceUpdate('composing', remoteJid);

    const questionContext = `The user is in the middle of a qualification flow and was asked: "${getCurrentQuestionText(session.state)}". Instead of answering, they asked: "${text}".
    
    Please answer their question briefly and professionally based on GoRan AI context. 
    At the very end of your response, politely guide the conversation back to the active discovery step by asking the exact question: "${getCurrentQuestionText(session.state)}"`;

    const aiResponse = await askGemini(questionContext, session.history);
    
    if (aiResponse.includes('[TRIGGER_BOOKING]')) {
      console.log(`[QUAL-BOOKING-TRIGGER] User requested direct booking during qualification.`);
      await initiateBookingFlow(sock, remoteJid, session);
      return;
    }

    // Save to message history
    session.history.push({ role: 'user', parts: [{ text: text }] });
    session.history.push({ role: 'model', parts: [{ text: aiResponse }] });

    await sock.sendMessage(remoteJid, { text: aiResponse });
    return;
  }

  // State Machine Flow
  switch (session.state) {
    case 'QUAL_BIZ_TYPE':
      session.leadData.bizType = text;
      session.state = 'QUAL_CHALLENGE';
      const q2 = "What's the biggest challenge you're facing right now?\n\n• Lead Generation\n• Operations\n• Customer Support\n• Recruitment\n• Follow-Ups\n• Something Else";
      await sock.sendMessage(remoteJid, { text: q2 });
      break;

    case 'QUAL_CHALLENGE':
      session.leadData.challenge = text;
      session.state = 'QUAL_PROCESS';
      await sock.sendMessage(remoteJid, { text: "How are you currently handling this process?" });
      break;

    case 'QUAL_PROCESS':
      session.leadData.process = text;
      session.state = 'QUAL_TEAM_SIZE';
      await sock.sendMessage(remoteJid, { text: "Roughly how many employees are on your team?" });
      break;

    case 'QUAL_TEAM_SIZE':
      session.leadData.teamSize = text;
      session.state = 'QUAL_EMAIL';
      
      // Stage 3: Give Value dynamically using Gemini
      await sock.sendPresenceUpdate('composing', remoteJid);
      
      const valResponse = await generateValueProposition(
        session.leadData.bizType || '',
        session.leadData.challenge || '',
        session.leadData.process || '',
        session.leadData.teamSize || ''
      );

      const valuePitch = `Based on what you've shared, I can already identify a few areas where AI automation may help:\n\n${valResponse}`;
      await sock.sendMessage(remoteJid, { text: valuePitch });

      // Stage 4: Soft Transition
      const softTransition = "Every business is different, so I'd need to understand your workflow in a little more detail before recommending an implementation plan.\n\nA short 15-minute strategy call is usually the fastest way to do that.";
      await sock.sendMessage(remoteJid, { text: softTransition });

      // Ask for Email (Soft Pitch)
      const emailPitch = "If you'd like, I can also send a summary of the opportunities we discussed.\n\nWhat's the best email address for that?";
      await sock.sendMessage(remoteJid, { text: emailPitch });
      break;

    case 'QUAL_EMAIL':
      session.leadData.email = text;
      session.state = 'QUAL_MEETING';

      const meetingPitch = "📅 *Would you like to schedule your 15-minute scoping call directly now?*\n\nIf yes, please reply with your preferred date and time (e.g. *Tomorrow at 3 PM*, or *Friday at 11 AM*).\n\nIf you prefer to book it later, reply with *skip*.";
      await sock.sendMessage(remoteJid, { text: meetingPitch });
      break;

    case 'QUAL_MEETING':
      if (lowerText === 'skip') {
        console.log(`[MEETING-SCHEDULER] User skipped calendar booking.`);
        await processAndSaveCompletedLead(sock, remoteJid, senderNumber, session);
      } else {
        await sock.sendPresenceUpdate('composing', remoteJid);
        const parsedTime = await parseMeetingTimeWithGemini(text);

        if (parsedTime && parsedTime.start && parsedTime.end) {
          try {
            console.log(`[MEETING-SCHEDULER] Creating event for ${senderNumber} at ${parsedTime.start}`);
            const eventLink = await createCalendarEvent({
              summary: `GoRan AI Strategy Call: ${session.leadData.bizType} & Ashish Ranjan`,
              description: `Automated scoping session for GoRan AI.\n\nLead Details:\n- Industry/Biz: ${session.leadData.bizType}\n- Challenge: ${session.leadData.challenge}\n- Current Process: ${session.leadData.process}\n- Team Size: ${session.leadData.teamSize}\n- Phone: +${senderNumber}\n- Email: ${session.leadData.email}\n- Questions: ${session.leadData.questionsAsked.join(', ') || 'None'}`,
              startIso: parsedTime.start,
              endIso: parsedTime.end,
              attendeeEmail: session.leadData.email || ''
            });

            // Save meeting details
            session.leadData.meetingTime = parsedTime.readable;
            session.leadData.meetingLink = eventLink || undefined;

            const confirmMsg = `📅 *Meeting Confirmed!*\nI've scheduled your strategy call for *${parsedTime.readable}* (IST) and sent a Google Calendar invitation to *${session.leadData.email}*.`;
            await sock.sendMessage(remoteJid, { text: confirmMsg });

            await processAndSaveCompletedLead(sock, remoteJid, senderNumber, session);
          } catch (err: any) {
            console.error('[MEETING-SCHEDULER] Google Calendar event creation failed:', err.message || err);
            await sock.sendMessage(remoteJid, { 
              text: "⚠️ I encountered an error while trying to connect to Google Calendar. Let's skip booking for now; our team will follow up via email with a scheduling link." 
            });
            await processAndSaveCompletedLead(sock, remoteJid, senderNumber, session);
          }
        } else {
          await sock.sendMessage(remoteJid, { 
            text: "⚠️ I couldn't quite resolve that date and time format. Could you try specifying it more clearly? (e.g. *June 5 at 3 PM* or *tomorrow at 11 AM*), or reply with *skip* to defer." 
          });
        }
      }
      break;

    case 'AI_CHAT':
      await sock.sendPresenceUpdate('composing', remoteJid);
      const aiReply = await askGemini(text, session.history);
      
      if (aiReply.includes('[TRIGGER_BOOKING]')) {
        console.log(`[AI-CHAT-BOOKING-TRIGGER] User requested booking in AI_CHAT.`);
        await initiateBookingFlow(sock, remoteJid, session);
        return;
      }
      
      session.history.push({ role: 'user', parts: [{ text: text }] });
      session.history.push({ role: 'model', parts: [{ text: aiReply }] });

      await sock.sendMessage(remoteJid, { text: aiReply });
      break;
  }
}

/**
 * Parses user preferred meeting time using Gemini API relative to current local time
 */
async function parseMeetingTimeWithGemini(userText: string): Promise<{ start: string, end: string, readable: string } | null> {
  const currentLocalTime = new Date().toString();
  const prompt = `You are a scheduling parser assistant. Today's date and time is: ${currentLocalTime} (local time in India, IST).
The user wants to book a 15-minute slot. They specified the time: "${userText}".

Perform these tasks:
1. Parse the user's input relative to the current local time. Assume the year is 2026.
2. Generate an ISO 8601 start timestamp (with timezone offset, e.g. +05:30) and an ISO 8601 end timestamp (exactly 15 minutes after start).
3. Create a clean, human-readable date/time string representing the meeting time in Indian Standard Time (e.g. "Thursday, June 4 at 3:00 PM").

Output your response strictly as a JSON string matching this structure:
{
  "start": "2026-06-04T15:00:00+05:30",
  "end": "2026-06-04T15:15:00+05:30",
  "readable": "Thursday, June 4 at 3:00 PM"
}

If the text cannot be resolved as a valid date and time, return an empty JSON: {}`;

  try {
    const rawReply = await askGemini(prompt, []);
    const result = parseGeminiJson(rawReply);
    if (!result || Object.keys(result).length === 0) return null;
    if (!result.start || !result.end) return null;
    return result;
  } catch (error) {
    console.error('[MEETING-PARSER] Error parsing date with Gemini:', error);
    return null;
  }
}

/**
 * Triggers the booking flow directly by asking for email or meeting time
 */
async function initiateBookingFlow(sock: WASocket, remoteJid: string, session: Session) {
  if (session.leadData.email) {
    session.state = 'QUAL_MEETING';
    const meetingPitch = "📅 *Let's book your scoping call directly!* Please reply with your preferred date and time (e.g. *Tomorrow at 3 PM*, or *Friday at 11 AM*).\n\nOr reply with *skip* if you prefer to schedule it later.";
    await sock.sendMessage(remoteJid, { text: meetingPitch });
  } else {
    session.state = 'QUAL_EMAIL';
    const emailPitch = "📅 *Let's book your scoping call directly!* What is the best email address to send the calendar invitation and scoping summary to?";
    await sock.sendMessage(remoteJid, { text: emailPitch });
  }
}

/**
 * Handle lead evaluation scoring, database record write, and send email alerts
 */
async function processAndSaveCompletedLead(sock: WASocket, remoteJid: string, senderNumber: string, session: Session) {
  // Score the lead using Gemini
  await sock.sendPresenceUpdate('composing', remoteJid);
  const scoreResult = await processCompletedLead(session.leadData);

  session.leadData.score = scoreResult.score;
  session.leadData.scoreReason = scoreResult.reason;
  session.leadData.summaryBlock = scoreResult.summary;

  // Save lead locally
  saveLeadRecord(session.leadData);

  // Send Email Alerts via Nodemailer
  await sendLeadEmails({
    phone: senderNumber,
    bizType: session.leadData.bizType || '',
    challenge: session.leadData.challenge || '',
    process: session.leadData.process || '',
    teamSize: session.leadData.teamSize || '',
    email: session.leadData.email || '',
    score: scoreResult.score,
    scoreReason: scoreResult.reason,
    summaryBlock: scoreResult.summary,
    meetingTime: session.leadData.meetingTime,
    meetingLink: session.leadData.meetingLink
  });

  // Reset state to AI_CHAT
  session.state = 'AI_CHAT';

  const completionMsg = "🎉 *Thank you! Your details and preferences have been recorded.*\n\n🤖 *Chat is active.* Feel free to ask me any other questions about GoRan AI!";
  await sock.sendMessage(remoteJid, { text: completionMsg });
}

/**
 * Heuristics to check if user is asking a question instead of answering
 */
function isAskingQuestion(text: string): boolean {
  const lower = text.toLowerCase();
  const questionWords = ['what', 'how', 'why', 'who', 'when', 'where', 'which', 'can you', 'does it', 'is there', 'price', 'cost', 'how much', 'rate', 'timeline', 'security', 'safe', 'meeting', 'call', 'appointment'];
  const hasQuestionMark = text.includes('?');
  const startsWithQuestionWord = questionWords.some(word => lower.startsWith(word) || lower.includes(' ' + word));
  return hasQuestionMark || startsWithQuestionWord;
}

/**
 * Returns prompt question text for guiding users back
 */
function getCurrentQuestionText(state: string): string {
  switch (state) {
    case 'QUAL_BIZ_TYPE':
      return "What type of business do you run?";
    case 'QUAL_CHALLENGE':
      return "What's the biggest challenge you're facing right now? (Lead Generation, Operations, Customer Support, Recruitment, Follow-Ups, Something Else)";
    case 'QUAL_PROCESS':
      return "How are you currently handling this process?";
    case 'QUAL_TEAM_SIZE':
      return "Roughly how many employees are on your team?";
    case 'QUAL_EMAIL':
      return "What's the best email address for that?";
    case 'QUAL_MEETING':
      return "Would you like to schedule your 15-minute scoping call directly now? (Or reply with 'skip')";
    default:
      return "";
  }
}

/**
 * Dynamic value recommendation generator
 */
async function generateValueProposition(bizType: string, challenge: string, process: string, teamSize: string): Promise<string> {
  const prompt = `Based on these business details:
- Business Type: ${bizType}
- Biggest Challenge: ${challenge}
- Current Process: ${process}
- Team Size: ${teamSize}

Please generate a highly professional, consultative value recommendation for GoRan AI.
Identify 3-4 specific areas where custom AI calling agents, voice agents, WhatsApp bots, or CRM automation can help this business save time and grow.
Use bullet points. Keep it punchy and direct for a WhatsApp message (use *bold* for headings).
Do not ask them to book a call yet, just give them value. Make them feel: "These guys actually understand my business."`;

  try {
    return await askGemini(prompt, []);
  } catch (error) {
    console.error('Error generating value proposition:', error);
    return `• Lead qualification automation\n• Follow-up sequences\n• CRM updates and dashboard synchronization`;
  }
}

/**
 * Lead scoring and summary block generator
 */
async function processCompletedLead(leadData: any): Promise<{ score: string, reason: string, summary: string }> {
  const prompt = `A prospect has completed our WhatsApp qualification flow. Here are the details:
- Phone: ${leadData.phone}
- Business Type: ${leadData.bizType || 'Not provided'}
- Challenge: ${leadData.challenge || 'Not provided'}
- Current Process: ${leadData.process || 'Not provided'}
- Team Size: ${leadData.teamSize || 'Not provided'}
- Email: ${leadData.email || 'Not provided'}
- Questions Asked: ${leadData.questionsAsked.join(', ') || 'None'}

Please perform lead scoring and summarize this lead:
1. Provide a score from 1 to 10 (e.g. "9/10").
2. Provide a 1-sentence reason for this score (based on business size, pain severity, budget/pricing questions, and response quality).
3. Generate a structured text summary block representing the lead exactly like this:
Lead Name: [Infer name or write Unknown]
Phone: [Phone]
Industry: [Industry]
Business Size: [Size]
Current Challenges:
- [Challenge]
Pain Points:
- [Pain Points]
Interest Level: [High/Medium/Low]
Call Readiness: [Interested in next 30 days/Curious]
Questions Asked:
- [Questions]
Recommended Solution:
- [Solutions]

Output your response as a JSON string matching this structure:
{
  "score": "9/10",
  "reason": "Reason here...",
  "summary": "Full formatted summary block here..."
}`;

  try {
    const rawReply = await askGemini(prompt, []);
    const result = parseGeminiJson(rawReply);
    return {
      score: result.score || '5/10',
      reason: result.reason || 'N/A',
      summary: result.summary || 'Summary could not be generated'
    };
  } catch (error) {
    console.error('Error scoring completed lead:', error);
    return {
      score: '5/10',
      reason: 'Failed to generate score automatically',
      summary: `Phone: ${leadData.phone}\nBusiness Type: ${leadData.bizType || 'N/A'}\nChallenge: ${leadData.challenge || 'N/A'}`
    };
  }
}

/**
 * Timeout lead compiler
 */
async function processTimeoutLead(leadData: any): Promise<{ score: string, reason: string, summary: string }> {
  const prompt = `A prospect started our WhatsApp qualification flow but became inactive. Here are the partial details collected:
- Phone: ${leadData.phone}
- Business Type: ${leadData.bizType || 'Not provided'}
- Challenge: ${leadData.challenge || 'Not provided'}
- Current Process: ${leadData.process || 'Not provided'}
- Team Size: ${leadData.teamSize || 'Not provided'}
- Email: ${leadData.email || 'Not provided'}
- Questions Asked: ${leadData.questionsAsked.join(', ') || 'None'}

Please perform lead scoring and summarize this partial lead:
1. Provide a score from 1 to 10.
2. Provide a 1-sentence reason for this score (based on business size, pain severity, and response quality).
3. Generate a structured text summary block representing the lead exactly like this:
Lead Name: [Infer name or write Unknown]
Phone: [Phone]
Industry: [Industry]
Business Size: [Size]
Current Challenges:
- [Challenge]
Pain Points:
- [Pain Points]
Interest Level: [Medium/Low]
Call Readiness: [Curious]
Questions Asked:
- [Questions]
Recommended Solution:
- [Solutions]

Output your response as a JSON string matching this structure:
{
  "score": "5/10",
  "reason": "Reason here...",
  "summary": "Full formatted summary block here..."
}`;

  try {
    const rawReply = await askGemini(prompt, []);
    const result = parseGeminiJson(rawReply);
    return {
      score: result.score || '5/10',
      reason: result.reason || 'N/A',
      summary: result.summary || 'Summary could not be generated'
    };
  } catch (error) {
    console.error('Error scoring timeout lead:', error);
    return {
      score: '4/10',
      reason: 'Failed to generate score automatically on timeout',
      summary: `Phone: ${leadData.phone}\nPartial Details: Business Type: ${leadData.bizType || 'N/A'}`
    };
  }
}

/**
 * Start/Refresh the 15-minute inactivity timer
 */
function refreshSessionTimeout(sock: WASocket, remoteJid: string) {
  const session = sessions[remoteJid];
  if (!session) return;

  if (session.timeoutTimer) {
    clearTimeout(session.timeoutTimer);
  }

  session.timeoutTimer = setTimeout(async () => {
    await handleSessionTimeout(sock, remoteJid);
  }, 15 * 60 * 1000); // 15 minutes
}

/**
 * Handle 15-minute session timeout
 */
async function handleSessionTimeout(sock: WASocket, remoteJid: string) {
  const session = sessions[remoteJid];
  if (!session) return;

  console.log(`[TIMEOUT-TRIGGERED] Inactivity timeout for JID: ${remoteJid}`);

  // Only compile and save lead if they answered at least Q1 (bizType is not empty) and haven't completed
  if (session.state !== 'AI_CHAT' && session.leadData && session.leadData.bizType) {
    console.log(`[TIMEOUT-LEAD-COMPILATION] Compiling partial details for: ${session.leadData.phone}`);
    
    try {
      const result = await processTimeoutLead(session.leadData);
      session.leadData.score = result.score;
      session.leadData.scoreReason = result.reason;
      session.leadData.summaryBlock = result.summary;

      saveLeadRecord(session.leadData);
      
      // Send partial lead email notification via SMTP
      await sendLeadEmails({
        phone: session.leadData.phone,
        bizType: session.leadData.bizType || 'Partial Info',
        challenge: session.leadData.challenge || 'N/A',
        process: session.leadData.process || 'N/A',
        teamSize: session.leadData.teamSize || 'N/A',
        email: session.leadData.email || 'N/A',
        score: result.score,
        scoreReason: result.reason,
        summaryBlock: result.summary,
        meetingTime: session.leadData.meetingTime,
        meetingLink: session.leadData.meetingLink
      });
      
      const timeoutMessage = "It's been a while, so I've saved the details you shared. If you'd like to resume or speak with our team, feel free to drop a message anytime!";
      await sock.sendMessage(remoteJid, { text: timeoutMessage });
    } catch (err) {
      console.error('Error compiling timeout lead:', err);
    }
  }

  // Clear session cache
  delete sessions[remoteJid];
}

/**
 * Save lead record helper
 */
function saveLeadRecord(leadData: any) {
  const filePath = path.join(__dirname, '../leads.json');
  let leads: any[] = [];
  
  try {
    if (fs.existsSync(filePath)) {
      const fileData = fs.readFileSync(filePath, 'utf8');
      leads = JSON.parse(fileData);
    }
  } catch (error) {
    console.error('Error reading leads.json:', error);
  }

  // Strip circular/timer references
  const record = {
    phone: leadData.phone,
    bizType: leadData.bizType,
    challenge: leadData.challenge,
    process: leadData.process,
    teamSize: leadData.teamSize,
    email: leadData.email,
    meetingTime: leadData.meetingTime,
    meetingLink: leadData.meetingLink,
    score: leadData.score,
    scoreReason: leadData.scoreReason,
    summaryBlock: leadData.summaryBlock,
    questionsAsked: leadData.questionsAsked,
    timestamp: leadData.timestamp
  };

  leads.push(record);

  try {
    fs.writeFileSync(filePath, JSON.stringify(leads, null, 2), 'utf8');
    console.log(`[LEAD-RECORDED] Lead saved locally for ${leadData.phone}. Score: ${leadData.score}`);
  } catch (error) {
    console.error('Error writing leads.json:', error);
  }

  // Save to MongoDB asynchronously
  saveLead(record).catch(err => {
    console.error('[DB-LEADS] Failed to save lead to MongoDB:', err.message || err);
  });
}

/**
 * Safely extracts and parses JSON from a Gemini string response.
 * Handles conversational prefixes/suffixes, markdown code blocks, etc.
 */
function parseGeminiJson(rawReply: string): any {
  const firstBrace = rawReply.indexOf('{');
  const lastBrace = rawReply.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('No JSON object found in response');
  }
  const cleanJson = rawReply.substring(firstBrace, lastBrace + 1).trim();
  if (cleanJson === '{}') return {};
  return JSON.parse(cleanJson);
}
