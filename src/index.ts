import * as dotenv from 'dotenv';
// Load environment variables immediately
dotenv.config();

import { startDashboardServer } from './services/dashboard';
import { connectDb, getWhitelistFromDb } from './services/db';

async function bootstrap() {
  // Gracefully connect to MongoDB
  try {
    await connectDb();
    if (process.env.ALLOWED_NUMBERS !== '*') {
      const dbNumbers = await getWhitelistFromDb();
      if (dbNumbers && dbNumbers.length > 0) {
        process.env.ALLOWED_NUMBERS = dbNumbers.join(',');
        console.log(`[BOOTSTRAP] Initialized whitelist from MongoDB: ${process.env.ALLOWED_NUMBERS}`);
      }
    } else {
      console.log(`[BOOTSTRAP] Whitelist disabled (set to '*' in .env). Allowing all numbers.`);
    }
  } catch (err: any) {
    console.error('⚠️ Failed to connect to MongoDB. Operating in local file-fallback mode:', err.message || err);
  }

  // Start HTTP Dashboard & Webhook Server
  const PORT = Number(process.env.PORT) || 3000;
  startDashboardServer(PORT);
}

bootstrap().catch((err) => {
  console.error('Unhandled critical error on startup:', err);
});
