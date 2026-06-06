import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getLeads, getWhitelistFromDb, saveWhitelistToDb, isDbConnected } from './db';
import { handleIncomingMessage } from '../bot';

/**
 * Helper function to extract text content from Meta WhatsApp message object
 */
function getMetaMessageText(message: any): string {
  if (!message) return '';
  
  if (message.type === 'text' && message.text) {
    return message.text.body || '';
  }
  
  if (message.type === 'interactive' && message.interactive) {
    const interactive = message.interactive;
    if (interactive.type === 'button_reply' && interactive.button_reply) {
      return interactive.button_reply.id || interactive.button_reply.title || '';
    }
    if (interactive.type === 'list_reply' && interactive.list_reply) {
      return interactive.list_reply.id || interactive.list_reply.title || '';
    }
  }
  
  if (message.type === 'button' && message.button) {
    return message.button.payload || message.button.text || '';
  }

  return '';
}

/**
 * Starts a lightweight HTTP server using Node's built-in 'http' module
 * to serve a premium live lead dashboard and the WhatsApp webhook endpoints.
 */
export function startDashboardServer(port: number) {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '';
    const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    
    // 1. GET /api/leads - Serve JSON leads list
    if (req.method === 'GET' && pathname === '/api/leads') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      
      try {
        if (isDbConnected()) {
          const leads = await getLeads();
          res.end(JSON.stringify(leads));
        } else {
          // File fallback
          const leadsPath = path.join(__dirname, '../../leads.json');
          if (fs.existsSync(leadsPath)) {
            const rawData = fs.readFileSync(leadsPath, 'utf8');
            res.end(rawData);
          } else {
            res.end(JSON.stringify([]));
          }
        }
      } catch (err) {
        console.error('[API-LEADS] Fetch error:', err);
        try {
          const leadsPath = path.join(__dirname, '../../leads.json');
          if (fs.existsSync(leadsPath)) {
            const rawData = fs.readFileSync(leadsPath, 'utf8');
            res.end(rawData);
          } else {
            res.end(JSON.stringify([]));
          }
        } catch (fileErr) {
          res.end(JSON.stringify({ error: 'Failed to read leads source' }));
        }
      }
      return;
    }
    
    // 2. GET /api/whitelist - Serve current whitelist array
    if (req.method === 'GET' && pathname === '/api/whitelist') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      
      try {
        if (isDbConnected()) {
          const numbers = await getWhitelistFromDb();
          if (numbers && numbers.length > 0) {
            res.end(JSON.stringify(numbers));
            return;
          }
        }
      } catch (err) {
        console.error('[API-WHITELIST] DB Fetch error:', err);
      }
      
      // Fallback to reading from .env file
      res.end(JSON.stringify(getWhitelist()));
      return;
    }
    
    // 3. POST /api/whitelist - Save updated whitelist
    if (req.method === 'POST' && pathname === '/api/whitelist') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          if (Array.isArray(data.numbers)) {
            const numbers = data.numbers
              .map((n: any) => String(n).trim())
              .filter((n: string) => /^\d+$/.test(n));
              
            // Save to DB as primary
            if (isDbConnected()) {
              await saveWhitelistToDb(numbers);
            }
            
            // Save to .env file as backup
            saveWhitelist(numbers);
            
            // Instantly apply in memory so the running bot updates live!
            process.env.ALLOWED_NUMBERS = numbers.join(',');
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, numbers }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid data format' }));
          }
        } catch (err) {
          console.error('[API-WHITELIST] Save error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to process request' }));
        }
      });
      return;
    }
    
    // 4. GET /webhook - Verify webhook verification challenge from Meta
    if (req.method === 'GET' && pathname === '/webhook') {
      const mode = parsedUrl.searchParams.get('hub.mode');
      const token = parsedUrl.searchParams.get('hub.verify_token');
      const challenge = parsedUrl.searchParams.get('hub.challenge');
      
      const verifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'goran_bot_verify_token';
      
      if (mode === 'subscribe' && token === verifyToken) {
        console.log('✅ [WEBHOOK] Webhook verified successfully.');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge);
      } else {
        console.warn('❌ [WEBHOOK] Webhook verification failed. Token mismatch.');
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
      }
      return;
    }

    // 5. POST /webhook - Process incoming WhatsApp messages
    if (req.method === 'POST' && pathname === '/webhook') {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          console.log('📥 [WEBHOOK] Received POST payload:', JSON.stringify(payload, null, 2));
          
          if (payload.object === 'whatsapp_business_account') {
            const entry = payload.entry?.[0];
            const change = entry?.changes?.[0];
            const value = change?.value;
            const message = value?.messages?.[0];
            
            if (message) {
              const from = message.from; // Sender phone number
              const messageText = getMetaMessageText(message);
              
              if (from && messageText) {
                // Run bot incoming message logic asynchronously, returning 200 OK immediately to Meta
                handleIncomingMessage(from, messageText).catch(err => {
                  console.error('❌ [WEBHOOK] Error handling message:', err);
                });
              }
            }
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'success' }));
        } catch (error: any) {
          console.error('❌ [WEBHOOK] Payload handling error:', error.message || error);
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad Request');
        }
      });
      return;
    }

    // 6. GET /dashboard || / - Serve HTML page
    if (req.method === 'GET' && (pathname === '/dashboard' || pathname === '/')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getDashboardHTML());
      return;
    }
    
    // 7. Fallback 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`📡 Live Lead Dashboard and Webhook is running at http://localhost:${port}/dashboard`);
    console.log(`📡 Meta Webhook Callback URL: http://localhost:${port}/webhook`);
  });
}

/**
 * Reads whitelisted numbers from active .env file
 */
function getWhitelist(): string[] {
  const envPath = path.join(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) return [];
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/^ALLOWED_NUMBERS=(.*)$/m);
    if (match) {
      return match[1].split(',').map(n => n.trim()).filter(n => n.length > 0);
    }
  } catch (error) {
    console.error('[DASHBOARD-SERVER] Error reading .env whitelist:', error);
  }
  return [];
}

/**
 * Writes whitelisted numbers back to active .env file
 */
function saveWhitelist(numbers: string[]) {
  const envPath = path.join(__dirname, '../../.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const numbersStr = numbers.join(',');
    let newContent = '';
    
    if (envContent.match(/^ALLOWED_NUMBERS=(.*)$/m)) {
      newContent = envContent.replace(/^ALLOWED_NUMBERS=.*$/m, `ALLOWED_NUMBERS=${numbersStr}`);
    } else {
      newContent = envContent + `\nALLOWED_NUMBERS=${numbersStr}\n`;
    }
    
    fs.writeFileSync(envPath, newContent, 'utf8');
    console.log(`[WHITELIST-SAVED] Whitelist successfully saved to .env: ${numbersStr}`);
  } catch (error) {
    console.error('[DASHBOARD-SERVER] Error writing .env whitelist:', error);
  }
}

function getDashboardHTML(): string {
  try {
    const htmlPath = path.join(process.cwd(), 'src/services/dashboard.html');
    if (fs.existsSync(htmlPath)) {
      return fs.readFileSync(htmlPath, 'utf8');
    } else {
      console.warn(`[DASHBOARD-SERVER] Dashboard HTML file not found at ${htmlPath}`);
      return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#070a13;color:#fff;padding:40px;"><h1>Dashboard HTML Source Not Found</h1><p>Expected file at: <code>${htmlPath}</code></p></body></html>`;
    }
  } catch (err: any) {
    console.error('[DASHBOARD-SERVER] Error reading dashboard.html:', err);
    return `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#070a13;color:#fff;padding:40px;"><h1>Internal Server Error</h1><p>${err.message || err}</p></body></html>`;
  }
}
