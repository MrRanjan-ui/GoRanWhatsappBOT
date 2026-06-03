import { WASocket } from '@whiskeysockets/baileys';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { askGemini, askGeminiRaw, GeminiMessage } from './gemini';
import { createCalendarEvent } from './services/calendar';
import { sendLeadEmails } from './services/mailer';
import { saveLead } from './services/db';

// Initialize dotenv immediately
dotenv.config();

// Load static texts
const configPath = path.join(__dirname, '../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Sessions state storage (In-memory)
interface LeadData {
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
}

interface Session {
  /** 'qualifying' = AI is naturally collecting lead info; 'booking' = waiting for date/time; 'chatting' = post-qualification free chat */
  phase: 'qualifying' | 'booking' | 'chatting';
  history: GeminiMessage[];
  timeoutTimer?: NodeJS.Timeout;
  leadData: LeadData;
  /** Tracks which qualification fields have been extracted so far */
  collectedFields: Set<string>;
  /** Whether the lead has already been saved */
  leadSaved: boolean;
}

const sessions: { [jid: string]: Session } = {};

// The fields we want to collect during qualification
const REQUIRED_FIELDS = ['bizType', 'challenge', 'process', 'teamSize', 'email'] as const;

/**
 * Build a dynamic system instruction that tells Gemini what info
 * is still missing so it can naturally work those questions into conversation.
 */
function buildQualificationSystemPrompt(collected: Set<string>): string {
  const missing: string[] = [];
  if (!collected.has('bizType'))   missing.push('What type of business they run');
  if (!collected.has('challenge')) missing.push('Their biggest challenge (e.g. lead gen, operations, support, recruitment, follow-ups)');
  if (!collected.has('process'))   missing.push('How they currently handle that process');
  if (!collected.has('teamSize'))  missing.push('Roughly how many employees they have');
  if (!collected.has('email'))     missing.push('Their email address (for sending a summary and calendar invite)');

  const collectedList = Array.from(collected);
  const collectedInfo = collectedList.length > 0
    ? `\nYou have already collected: ${collectedList.join(', ')}. Do NOT re-ask for these.`
    : '';

  const allCollected = missing.length === 0;

  return `${config.systemInstruction}

### YOUR CURRENT ROLE — AI Sales Consultant & Lead Qualifier
You are having a REAL, natural conversation on WhatsApp. You are NOT a form or a quiz.
${collectedInfo}

${allCollected
  ? `ALL qualification data has been collected! 🎉
Now do one of these:
- Provide a short, personalized value insight based on their business details.
- Naturally suggest booking a 15-minute strategy call. Ask for their preferred date/time.
- If they already gave a preferred time, output exactly: [TRIGGER_BOOKING]
- Otherwise, continue chatting helpfully about their business.`
  : `You still need to learn the following (weave them into conversation NATURALLY — do NOT ask all at once, do NOT list them as a numbered form):
${missing.map((m, i) => `${i + 1}. ${m}`).join('\n')}

GUIDELINES:
- Ask ONE missing piece of info at a time, max two if they're closely related.
- React to what the user says — acknowledge their answers, show empathy, give a brief insight, THEN ask the next question.
- If the user asks YOU a question mid-flow, answer it helpfully and then smoothly continue gathering info.
- Sound like a smart AI consultant, NOT a script reader.`
}

### BOOKING TRIGGER
If the user explicitly asks to book a call, schedule a meeting, or start a project, reply with EXACTLY: [TRIGGER_BOOKING]
Do not output the booking link yourself.

### FORMAT
- Keep messages concise and punchy for WhatsApp (not too long).
- Use *bold* for emphasis. Use bullet points when helpful.
- Be warm, professional, and consultative.`;
}

/**
 * Main message handler — fully AI-driven
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

  // Reset command
  if (lowerText === 'menu' || lowerText === 'exit' || lowerText === 'reset' || lowerText === 'home') {
    delete sessions[remoteJid];
    // Fall through to create a new session below
  }

  // Initialize session if needed
  const isNewSession = !sessions[remoteJid];
  if (isNewSession) {
    sessions[remoteJid] = {
      phase: 'qualifying',
      history: [],
      leadData: {
        phone: senderNumber,
        questionsAsked: [],
        timestamp: new Date().toISOString()
      },
      collectedFields: new Set(),
      leadSaved: false
    };
  }

  const session = sessions[remoteJid];

  // Refresh the 15-minute inactivity timer
  refreshSessionTimeout(sock, remoteJid);

  // Handle based on phase
  switch (session.phase) {
    case 'qualifying':
    case 'chatting':
      await handleAIConversation(sock, remoteJid, session, text, isNewSession);
      break;

    case 'booking':
      await handleBookingResponse(sock, remoteJid, session, text);
      break;
  }
}

/**
 * Core AI conversation handler — used for both qualification and free chat
 */
async function handleAIConversation(sock: WASocket, remoteJid: string, session: Session, userText: string, isFirstMessage: boolean) {
  await sock.sendPresenceUpdate('composing', remoteJid);

  // Build the appropriate system prompt
  const systemPrompt = session.phase === 'qualifying'
    ? buildQualificationSystemPrompt(session.collectedFields)
    : config.systemInstruction + '\n\nYou are in open chat mode. The user has already been qualified. Be helpful, answer any questions about GoRan AI, and if they want to book a call, reply with exactly: [TRIGGER_BOOKING]';

  // For the very first message, prepend a greeting context
  const effectiveUserText = isFirstMessage
    ? `[The user just sent their first message to start a conversation. Greet them warmly and start qualifying naturally.]\n\nUser's message: "${userText}"`
    : userText;

  // Get AI response
  const aiResponse = await askGemini(effectiveUserText, session.history, systemPrompt);

  // Check for booking trigger
  if (aiResponse.includes('[TRIGGER_BOOKING]')) {
    console.log(`[BOOKING-TRIGGER] User requested booking during ${session.phase} phase.`);
    await initiateBookingFlow(sock, remoteJid, session);
    return;
  }

  // Save to conversation history
  session.history.push({ role: 'user', parts: [{ text: userText }] });
  session.history.push({ role: 'model', parts: [{ text: aiResponse }] });

  // Send the AI response
  await sock.sendMessage(remoteJid, { text: aiResponse });

  // Background: extract any new qualification data from conversation
  if (session.phase === 'qualifying') {
    await extractQualificationData(session);

    // Check if all fields are now collected
    const allCollected = REQUIRED_FIELDS.every(f => session.collectedFields.has(f));
    if (allCollected && !session.leadSaved) {
      console.log(`[QUALIFICATION-COMPLETE] All fields collected for ${session.leadData.phone}`);
      await processAndSaveCompletedLead(sock, remoteJid, session);
    }
  }
}

/**
 * Extract structured qualification data from conversation history using Gemini
 */
async function extractQualificationData(session: Session) {
  // Only extract if there's enough conversation (at least 2 exchanges)
  if (session.history.length < 4) return;

  const conversationText = session.history
    .map(m => `${m.role === 'user' ? 'User' : 'Bot'}: ${m.parts[0].text}`)
    .join('\n');

  const extractionPrompt = `Analyze this WhatsApp conversation and extract any business qualification data the USER has shared.

CONVERSATION:
${conversationText}

Extract ONLY information the USER explicitly stated. Output a JSON object with these fields (use null for anything not yet mentioned):
{
  "bizType": "type of business they run (string or null)",
  "challenge": "their biggest challenge (string or null)",
  "process": "how they currently handle it (string or null)",
  "teamSize": "team/employee count (string or null)",
  "email": "their email address (string or null)"
}

RULES:
- Only extract data the USER actually provided. Do NOT infer or guess.
- For email, only extract if it looks like a valid email address.
- Return ONLY the JSON, no other text.`;

  try {
    const rawReply = await askGeminiRaw(extractionPrompt);
    const extracted = parseGeminiJson(rawReply);

    if (extracted) {
      if (extracted.bizType && !session.collectedFields.has('bizType')) {
        session.leadData.bizType = extracted.bizType;
        session.collectedFields.add('bizType');
        console.log(`[DATA-EXTRACTED] bizType: ${extracted.bizType}`);
      }
      if (extracted.challenge && !session.collectedFields.has('challenge')) {
        session.leadData.challenge = extracted.challenge;
        session.collectedFields.add('challenge');
        console.log(`[DATA-EXTRACTED] challenge: ${extracted.challenge}`);
      }
      if (extracted.process && !session.collectedFields.has('process')) {
        session.leadData.process = extracted.process;
        session.collectedFields.add('process');
        console.log(`[DATA-EXTRACTED] process: ${extracted.process}`);
      }
      if (extracted.teamSize && !session.collectedFields.has('teamSize')) {
        session.leadData.teamSize = extracted.teamSize;
        session.collectedFields.add('teamSize');
        console.log(`[DATA-EXTRACTED] teamSize: ${extracted.teamSize}`);
      }
      if (extracted.email && !session.collectedFields.has('email')) {
        session.leadData.email = extracted.email;
        session.collectedFields.add('email');
        console.log(`[DATA-EXTRACTED] email: ${extracted.email}`);
      }
    }
  } catch (err) {
    console.error('[DATA-EXTRACTION] Error extracting qualification data:', err);
  }
}

/**
 * Handle the booking date/time response
 */
async function handleBookingResponse(sock: WASocket, remoteJid: string, session: Session, userText: string) {
  const lowerText = userText.toLowerCase();

  if (lowerText === 'skip' || lowerText === 'later' || lowerText === 'no') {
    console.log(`[BOOKING] User skipped calendar booking.`);
    session.phase = 'chatting';
    
    await sock.sendPresenceUpdate('composing', remoteJid);
    const skipResponse = await askGemini(
      "The user decided to skip booking a call for now. Acknowledge this gracefully, let them know the team will follow up via email, and invite them to continue chatting or ask any questions.",
      session.history,
      config.systemInstruction
    );
    session.history.push({ role: 'user', parts: [{ text: userText }] });
    session.history.push({ role: 'model', parts: [{ text: skipResponse }] });
    await sock.sendMessage(remoteJid, { text: skipResponse });
    return;
  }

  // Try to parse the meeting time
  await sock.sendPresenceUpdate('composing', remoteJid);
  const parsedTime = await parseMeetingTimeWithGemini(userText);

  if (parsedTime && parsedTime.start && parsedTime.end) {
    try {
      console.log(`[MEETING-SCHEDULER] Creating event for ${session.leadData.phone} at ${parsedTime.start}`);
      const eventLink = await createCalendarEvent({
        summary: `GoRan AI Strategy Call: ${session.leadData.bizType || 'Prospect'} & Ashish Ranjan`,
        description: `Automated scoping session for GoRan AI.\n\nLead Details:\n- Industry/Biz: ${session.leadData.bizType}\n- Challenge: ${session.leadData.challenge}\n- Current Process: ${session.leadData.process}\n- Team Size: ${session.leadData.teamSize}\n- Phone: +${session.leadData.phone}\n- Email: ${session.leadData.email}\n- Questions: ${session.leadData.questionsAsked.join(', ') || 'None'}`,
        startIso: parsedTime.start,
        endIso: parsedTime.end,
        attendeeEmail: session.leadData.email || ''
      });

      session.leadData.meetingTime = parsedTime.readable;
      session.leadData.meetingLink = eventLink || undefined;

      const confirmResponse = await askGemini(
        `The meeting has been successfully booked for ${parsedTime.readable} (IST). A Google Calendar invitation has been sent to ${session.leadData.email}. ${eventLink ? `Meeting link: ${eventLink}` : ''}. Confirm this enthusiastically to the user and invite them to continue chatting about anything else.`,
        session.history,
        config.systemInstruction
      );

      session.history.push({ role: 'user', parts: [{ text: userText }] });
      session.history.push({ role: 'model', parts: [{ text: confirmResponse }] });
      await sock.sendMessage(remoteJid, { text: confirmResponse });
      session.phase = 'chatting';

    } catch (err: any) {
      console.error('[MEETING-SCHEDULER] Google Calendar event creation failed:', err.message || err);
      const errorResponse = await askGemini(
        "There was a technical error connecting to Google Calendar. Apologize to the user, let them know the team will follow up via email with a scheduling link, and invite them to keep chatting.",
        session.history,
        config.systemInstruction
      );
      session.history.push({ role: 'user', parts: [{ text: userText }] });
      session.history.push({ role: 'model', parts: [{ text: errorResponse }] });
      await sock.sendMessage(remoteJid, { text: errorResponse });
      session.phase = 'chatting';
    }
  } else {
    // Couldn't parse — ask again via AI
    const retryResponse = await askGemini(
      `The user tried to provide a meeting time but I couldn't parse "${userText}". Ask them politely to try a clearer format like "Tomorrow at 3 PM" or "June 10 at 11 AM". Also mention they can type "skip" to defer.`,
      session.history,
      config.systemInstruction
    );
    session.history.push({ role: 'user', parts: [{ text: userText }] });
    session.history.push({ role: 'model', parts: [{ text: retryResponse }] });
    await sock.sendMessage(remoteJid, { text: retryResponse });
  }
}

/**
 * Triggers the booking flow by asking for preferred date/time
 */
async function initiateBookingFlow(sock: WASocket, remoteJid: string, session: Session) {
  session.phase = 'booking';

  // If we don't have email yet, ask for it first via AI
  if (!session.leadData.email) {
    const emailAsk = await askGemini(
      "The user wants to book a call but we don't have their email yet. Ask for their email address naturally — explain we need it to send the calendar invitation and a summary of the opportunities discussed. Then ask for their preferred date and time.",
      session.history,
      config.systemInstruction
    );
    // Temporarily go back to qualifying to collect email first, then re-trigger
    session.phase = 'qualifying';
    session.history.push({ role: 'model', parts: [{ text: emailAsk }] });
    await sock.sendMessage(remoteJid, { text: emailAsk });
    return;
  }

  await sock.sendPresenceUpdate('composing', remoteJid);
  const bookingPrompt = await askGemini(
    "The user wants to book a strategy call. Ask them enthusiastically for their preferred date and time (e.g., 'Tomorrow at 3 PM' or 'Friday at 11 AM'). Mention they can also type 'skip' to schedule later. Keep it brief and WhatsApp-friendly.",
    session.history,
    config.systemInstruction
  );
  session.history.push({ role: 'model', parts: [{ text: bookingPrompt }] });
  await sock.sendMessage(remoteJid, { text: bookingPrompt });
}

/**
 * Handle lead scoring, saving, and email notifications
 */
async function processAndSaveCompletedLead(sock: WASocket, remoteJid: string, session: Session) {
  if (session.leadSaved) return;
  session.leadSaved = true;

  // Score the lead using Gemini
  const scoreResult = await scoreCompletedLead(session.leadData);
  session.leadData.score = scoreResult.score;
  session.leadData.scoreReason = scoreResult.reason;
  session.leadData.summaryBlock = scoreResult.summary;

  // Save lead locally to file
  saveLeadToFile(session.leadData);

  // Send email alerts
  await sendLeadEmails({
    phone: session.leadData.phone,
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

  // Transition to chatting phase
  session.phase = 'chatting';
  console.log(`[LEAD-COMPLETE] Lead processed and saved for ${session.leadData.phone}. Score: ${scoreResult.score}`);
}

/**
 * Parses user preferred meeting time using Gemini API
 */
async function parseMeetingTimeWithGemini(userText: string): Promise<{ start: string, end: string, readable: string } | null> {
  const currentLocalTime = new Date().toString();
  const prompt = `You are a scheduling parser. Today is: ${currentLocalTime} (India, IST).
The user wants a 15-minute slot: "${userText}".

Parse this relative to current time (assume year 2026) and output ONLY a JSON object:
{
  "start": "ISO 8601 with +05:30 offset",
  "end": "ISO 8601 15 min after start",
  "readable": "e.g. Thursday, June 4 at 3:00 PM"
}

If unparseable, output: {}`;

  try {
    const rawReply = await askGeminiRaw(prompt);
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
 * Lead scoring using Gemini
 */
async function scoreCompletedLead(leadData: LeadData): Promise<{ score: string, reason: string, summary: string }> {
  const prompt = `Score this qualified lead:
- Phone: ${leadData.phone}
- Business: ${leadData.bizType || 'N/A'}
- Challenge: ${leadData.challenge || 'N/A'}
- Current Process: ${leadData.process || 'N/A'}
- Team Size: ${leadData.teamSize || 'N/A'}
- Email: ${leadData.email || 'N/A'}
- Questions: ${leadData.questionsAsked.join(', ') || 'None'}

Output ONLY JSON:
{
  "score": "X/10",
  "reason": "One sentence reason",
  "summary": "Formatted lead summary block"
}`;

  try {
    const rawReply = await askGeminiRaw(prompt);
    const result = parseGeminiJson(rawReply);
    return {
      score: result.score || '5/10',
      reason: result.reason || 'N/A',
      summary: result.summary || 'Summary unavailable'
    };
  } catch (error) {
    console.error('Error scoring lead:', error);
    return {
      score: '5/10',
      reason: 'Auto-scoring failed',
      summary: `Phone: ${leadData.phone}\nBusiness: ${leadData.bizType || 'N/A'}\nChallenge: ${leadData.challenge || 'N/A'}`
    };
  }
}

/**
 * Score a timed-out partial lead
 */
async function scoreTimeoutLead(leadData: LeadData): Promise<{ score: string, reason: string, summary: string }> {
  const prompt = `Score this PARTIAL lead (user went inactive):
- Phone: ${leadData.phone}
- Business: ${leadData.bizType || 'Not provided'}
- Challenge: ${leadData.challenge || 'Not provided'}
- Process: ${leadData.process || 'Not provided'}
- Team Size: ${leadData.teamSize || 'Not provided'}
- Email: ${leadData.email || 'Not provided'}
- Questions: ${leadData.questionsAsked.join(', ') || 'None'}

Output ONLY JSON:
{
  "score": "X/10",
  "reason": "One sentence reason",
  "summary": "Formatted lead summary"
}`;

  try {
    const rawReply = await askGeminiRaw(prompt);
    const result = parseGeminiJson(rawReply);
    return {
      score: result.score || '4/10',
      reason: result.reason || 'N/A',
      summary: result.summary || 'Partial lead'
    };
  } catch (error) {
    console.error('Error scoring timeout lead:', error);
    return {
      score: '4/10',
      reason: 'Auto-scoring failed on timeout',
      summary: `Phone: ${leadData.phone}\nBusiness: ${leadData.bizType || 'N/A'}`
    };
  }
}

/**
 * Refresh the 15-minute inactivity timer
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

  // Save partial lead if user provided at least some info
  if (!session.leadSaved && session.leadData.bizType) {
    console.log(`[TIMEOUT-LEAD] Compiling partial lead for: ${session.leadData.phone}`);

    try {
      // Extract any remaining data from conversation
      await extractQualificationData(session);

      const result = await scoreTimeoutLead(session.leadData);
      session.leadData.score = result.score;
      session.leadData.scoreReason = result.reason;
      session.leadData.summaryBlock = result.summary;

      saveLeadToFile(session.leadData);

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

      const timeoutMsg = await askGemini(
        "The user has been inactive for 15 minutes. Send them a brief, warm message saying you've saved their details and they can come back anytime to resume the conversation or book a call.",
        session.history,
        config.systemInstruction
      );
      await sock.sendMessage(remoteJid, { text: timeoutMsg });
    } catch (err) {
      console.error('Error compiling timeout lead:', err);
    }
  }

  delete sessions[remoteJid];
}

/**
 * Save lead record to local JSON file
 */
function saveLeadToFile(leadData: LeadData) {
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
    console.log(`[LEAD-SAVED] Lead saved locally for ${leadData.phone}. Score: ${leadData.score}`);
  } catch (error) {
    console.error('Error writing leads.json:', error);
  }

  // Save to MongoDB asynchronously
  saveLead(record).catch(err => {
    console.error('[DB-LEADS] Failed to save lead to MongoDB:', err.message || err);
  });
}

/**
 * Safely extract JSON from a Gemini response
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
