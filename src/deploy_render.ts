import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env variables
dotenv.config();

const RENDER_API_KEY = 'rnd_uCI9wT7ugoWO8YsZquaXzCCBtPID';
const REPO_URL = 'https://github.com/MrRanjan-ui/GoRanWhatsappBOT.git';

async function deploy() {
  console.log('🚀 Initiating automated Render deployment...');

  // 1. Fetch Workspaces
  console.log('🔍 Fetching Render workspaces...');
  const workspacesResponse = await fetch('https://api.render.com/v1/owners', {
    headers: {
      'Authorization': `Bearer ${RENDER_API_KEY}`,
      'Accept': 'application/json'
    }
  });

  if (!workspacesResponse.ok) {
    console.error('❌ Failed to fetch workspaces:', await workspacesResponse.text());
    process.exit(1);
  }

  const workspaces: any = await workspacesResponse.json();
  if (workspaces.length === 0) {
    console.error('❌ No workspaces found in your Render account.');
    process.exit(1);
  }

  // Get the first workspace/owner ID
  const workspaceId = workspaces[0].owner.id;
  const workspaceName = workspaces[0].owner.name;
  console.log(`✅ Using workspace: ${workspaceName} (${workspaceId})`);

  // 2. Prepare Environment Variables
  const envVars = [
    { key: 'PORT', value: '3000' },
    { key: 'ALLOWED_NUMBERS', value: process.env.ALLOWED_NUMBERS || '916203025198' },
    { key: 'MONGODB_URI', value: process.env.MONGODB_URI || 'mongodb://localhost:27017/goran-bot' },
    { key: 'GEMINI_API_KEY', value: process.env.GEMINI_API_KEY || '' },
    { key: 'GOOGLE_SERVICE_ACCOUNT_EMAIL', value: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '' },
    { key: 'GOOGLE_PRIVATE_KEY', value: process.env.GOOGLE_PRIVATE_KEY || '' },
    { key: 'GOOGLE_CALENDAR_ID', value: process.env.GOOGLE_CALENDAR_ID || '' },
    { key: 'SMTP_HOST', value: process.env.SMTP_HOST || 'smtp.gmail.com' },
    { key: 'SMTP_PORT', value: process.env.SMTP_PORT || '465' },
    { key: 'SMTP_USER', value: process.env.SMTP_USER || '' },
    { key: 'SMTP_PASS', value: process.env.SMTP_PASS || '' },
    { key: 'NOTIFICATION_EMAIL', value: process.env.NOTIFICATION_EMAIL || '' }
  ];

  // 3. Create Web Service
  console.log('🖥️ Creating Render Web Service...');
  const servicePayload = {
    name: 'goran-whatsapp-bot',
    type: 'web_service',
    repo: REPO_URL,
    branch: 'main',
    autoDeploy: 'yes',
    ownerId: workspaceId,
    serviceDetails: {
      runtime: 'node',
      buildCommand: 'npm run build',
      startCommand: 'npm run start',
      plan: 'free',
      region: 'oregon',
      envVars: envVars
    }
  };

  const createResponse = await fetch('https://api.render.com/v1/services', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RENDER_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(servicePayload)
  });

  const responseText = await createResponse.text();
  if (createResponse.ok) {
    const data = JSON.parse(responseText);
    console.log('\n✨ Service deployed successfully!');
    console.log(`🔗 Live URL: ${data.service.serviceDetails.url}`);
    console.log(`🔗 Render Dashboard URL: https://dashboard.render.com/web/${data.service.id}`);
  } else {
    console.error('\n❌ Failed to create service:', responseText);
  }
}

deploy().catch(err => {
  console.error('❌ Unexpected error:', err);
});
