import * as dotenv from 'dotenv';
// Load environment variables immediately
dotenv.config();

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  proto
} from '@whiskeysockets/baileys';
import * as path from 'path';
import pino from 'pino';
import * as qrcode from 'qrcode-terminal';
import { handleIncomingMessage } from './bot';
import { startDashboardServer } from './services/dashboard';
import { connectDb, getWhitelistFromDb } from './services/db';

// Configure Baileys logger
// set level to 'silent' or 'warn' to avoid cluttering the terminal, keeping 'info' for connection updates
const logger = pino({ level: 'info' });

async function startBot() {
  // Fetch latest WhatsApp Web client version to avoid 405 error
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📡 Using WhatsApp Web version: v${version.join('.')}, isLatest: ${isLatest}`);

  const authFolder = process.env.AUTH_DIR || path.join(__dirname, '../auth_info_baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  console.log('🔄 Initializing WhatsApp client connection...');

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // We will custom print it using qrcode-terminal for better display
    logger: logger,
    defaultQueryTimeoutMs: 120000, // 2 minutes to prevent initial query timeouts on large accounts
    connectTimeoutMs: 60000,       // 1 minute timeout for connection
    keepAliveIntervalMs: 30000,     // 30 seconds keep alive
    shouldSyncHistoryMessage: () => false // Disable history synchronization entirely
  });

  // Save credentials on updates
  sock.ev.on('creds.update', saveCreds);

  // Monitor connection states
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📌 Scan the QR code below using your WhatsApp (Linked Devices) to log in:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`🔌 Connection closed due to: ${lastDisconnect?.error || 'unknown error'}, status code: ${statusCode}`);
      
      if (shouldReconnect) {
        console.log('🔁 Reconnecting in 5 seconds...');
        setTimeout(() => startBot(), 5000);
      } else {
        console.log('❌ Logged out. Please scan QR code again. Clearing session data...');
        // Optional: clear auth_info_baileys if logged out to force new QR scan
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp bot is online and listening for messages!');
    }
  });

  // Listen for incoming messages
  sock.ev.on('messages.upsert', async (upsert) => {
    console.log(`[UPSERT-DEBUG] Received event type: ${upsert.type}, count: ${upsert.messages.length}`);
    const { messages, type } = upsert;
    
    // Ignore if not a new message (notify)
    if (type !== 'notify') return;

    for (const msg of messages) {
      console.log(`[MESSAGE-DEBUG] Raw message payload:`, JSON.stringify(msg, null, 2));

      // Ignore if sent by the bot itself
      if (msg.key.fromMe) {
        console.log(`[MESSAGE-DEBUG] Ignored: message is fromMe (sent by bot itself)`);
        continue;
      }

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) {
        console.log(`[MESSAGE-DEBUG] Ignored: remoteJid is null`);
        continue;
      }

      // Allow direct chats (ends with @s.whatsapp.net or @lid)
      if (!remoteJid.endsWith('@s.whatsapp.net') && !remoteJid.endsWith('@lid')) {
        console.log(`[MESSAGE-DEBUG] Ignored: not a direct message (remoteJid: ${remoteJid})`);
        continue;
      }

      // Ignore messages older than 60 seconds (prevents replying to old history/offline syncs)
      const messageTimestamp = Number(msg.messageTimestamp) || 0;
      const messageTimeMs = messageTimestamp * 1000;
      const ageMs = Date.now() - messageTimeMs;
      if (ageMs > 60 * 1000) {
        console.log(`[MESSAGE-DEBUG] Ignored: message is older than 60s (age: ${Math.round(ageMs/1000)}s)`);
        continue;
      }

      const senderNumber = getSenderPhoneNumber(msg);
      const messageText = getMessageText(msg);
      console.log(`[MESSAGE-DEBUG] Extracted text: "${messageText}" from JID ${remoteJid} (Phone: ${senderNumber})`);
      if (!messageText) {
        console.log(`[MESSAGE-DEBUG] Ignored: messageText is empty/null`);
        continue;
      }

      try {
        await handleIncomingMessage(sock, remoteJid, senderNumber, messageText);
      } catch (error) {
        console.error(`Error handling message from ${remoteJid}:`, error);
      }
    }
  });
}

/**
 * Extracts the sender's phone number without domain suffix from a message
 */
function getSenderPhoneNumber(msg: proto.IWebMessageInfo): string {
  const remoteJid = msg.key.remoteJid || '';
  const key = msg.key as any;

  if (key.senderPn) {
    return key.senderPn.split('@')[0];
  }
  
  if (key.participantPn) {
    return key.participantPn.split('@')[0];
  }

  if (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid')) {
    return remoteJid.split('@')[0];
  }

  const participant = key.participant || '';
  if (participant) {
    return participant.split('@')[0];
  }

  return '';
}

/**
 * Extracts text content from a Baileys message object
 */
function getMessageText(m: proto.IWebMessageInfo): string {
  if (!m.message) return '';

  const msg = m.message;

  // Extract from conversation
  if (msg.conversation) return msg.conversation;

  // Extract from extended text message (contains links, font details, mentions)
  if (msg.extendedTextMessage && msg.extendedTextMessage.text) {
    return msg.extendedTextMessage.text;
  }

  // Extract from button response message
  if (msg.buttonsResponseMessage && msg.buttonsResponseMessage.selectedButtonId) {
    return msg.buttonsResponseMessage.selectedButtonId;
  }

  // Extract from list response message
  if (msg.listResponseMessage && msg.listResponseMessage.singleSelectReply && msg.listResponseMessage.singleSelectReply.selectedRowId) {
    return msg.listResponseMessage.singleSelectReply.selectedRowId;
  }

  // Extract from template button reply
  if (msg.templateButtonReplyMessage && msg.templateButtonReplyMessage.selectedId) {
    return msg.templateButtonReplyMessage.selectedId;
  }

  return '';
}

async function bootstrap() {
  // Gracefully connect to MongoDB
  try {
    await connectDb();
    const dbNumbers = await getWhitelistFromDb();
    if (dbNumbers && dbNumbers.length > 0) {
      process.env.ALLOWED_NUMBERS = dbNumbers.join(',');
      console.log(`[BOOTSTRAP] Initialized whitelist from MongoDB: ${process.env.ALLOWED_NUMBERS}`);
    }
  } catch (err: any) {
    console.error('⚠️ Failed to connect to MongoDB. Operating in local file-fallback mode:', err.message || err);
  }

  // Start HTTP Dashboard Server
  const DASHBOARD_PORT = Number(process.env.PORT) || 3000;
  startDashboardServer(DASHBOARD_PORT);

  // Start the bot client connection instance runner
  startBot().catch((err) => {
    console.error('Unhandled critical error on bot startup:', err);
  });
}

bootstrap();
