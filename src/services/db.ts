import { MongoClient, Db } from 'mongodb';
import * as dotenv from 'dotenv';

dotenv.config();

const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/goran-bot';
let client: MongoClient;
let db: Db;

/**
 * Initializes and connects to the MongoDB database.
 */
export async function connectDb(): Promise<Db> {
  if (db) return db;
  
  try {
    console.log(`🔌 Connecting to MongoDB at ${uri.split('@').pop()}...`);
    client = new MongoClient(uri);
    await client.connect();
    db = client.db();
    console.log('✅ Successfully connected to MongoDB.');
    
    // Seed whitelist from .env if the database setting is empty
    await seedWhitelistIfEmpty();
    
    return db;
  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error);
    throw error;
  }
}

/**
 * Gets the database instance.
 */
export function getDb(): Db {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db;
}

/**
 * Checks if the database is connected.
 */
export function isDbConnected(): boolean {
  return !!db;
}

/**
 * Inserts a new lead into the 'leads' collection
 */
export async function saveLead(leadData: any) {
  try {
    const database = getDb();
    const collection = database.collection('leads');
    
    // Format lead to ensure clean fields
    const record = {
      phone: leadData.phone,
      bizType: leadData.bizType || '',
      challenge: leadData.challenge || '',
      process: leadData.process || '',
      teamSize: leadData.teamSize || '',
      email: leadData.email || '',
      meetingTime: leadData.meetingTime || '',
      meetingLink: leadData.meetingLink || '',
      score: leadData.score || '',
      scoreReason: leadData.scoreReason || '',
      summaryBlock: leadData.summaryBlock || '',
      questionsAsked: leadData.questionsAsked || [],
      timestamp: leadData.timestamp || new Date().toISOString()
    };
    
    const result = await collection.insertOne(record);
    console.log(`[DB-LEADS] Saved lead to MongoDB. ID: ${result.insertedId}`);
    return result;
  } catch (error) {
    console.error('[DB-LEADS] Error saving lead to MongoDB:', error);
  }
}

/**
 * Updates the booking details for the latest lead of a given phone number.
 */
export async function updateLeadBooking(phone: string, meetingTime: string, meetingLink: string) {
  try {
    const database = getDb();
    const collection = database.collection('leads');
    
    // Find the latest lead document for this phone number
    const latestLead = await collection.findOne(
      { phone },
      { sort: { timestamp: -1 } }
    );
    
    if (latestLead) {
      const result = await collection.updateOne(
        { _id: latestLead._id },
        { $set: { meetingTime, meetingLink } }
      );
      console.log(`[DB-LEADS] Updated booking for lead ID ${latestLead._id}: ${meetingTime}`);
      return result;
    } else {
      console.warn(`[DB-LEADS] No lead found to update booking for phone: ${phone}`);
    }
  } catch (error) {
    console.error('[DB-LEADS] Error updating lead booking in MongoDB:', error);
  }
}

/**
 * Fetches all leads from the 'leads' collection sorted by newest first
 */
export async function getLeads(): Promise<any[]> {
  try {
    const database = getDb();
    const collection = database.collection('leads');
    return await collection.find({}).sort({ timestamp: -1 }).toArray();
  } catch (error) {
    console.error('[DB-LEADS] Error fetching leads from MongoDB:', error);
    return [];
  }
}

/**
 * Fetches the whitelisted phone numbers array from 'settings'
 */
export async function getWhitelistFromDb(): Promise<string[]> {
  try {
    const database = getDb();
    const collection = database.collection('settings');
    const doc = await collection.findOne({ key: 'whitelist' });
    if (doc && Array.isArray(doc.numbers)) {
      return doc.numbers;
    }
  } catch (error) {
    console.error('[DB-SETTINGS] Error fetching whitelist from MongoDB:', error);
  }
  return [];
}

/**
 * Saves the whitelisted phone numbers array into 'settings'
 */
export async function saveWhitelistToDb(numbers: string[]) {
  try {
    const database = getDb();
    const collection = database.collection('settings');
    
    await collection.updateOne(
      { key: 'whitelist' },
      { $set: { numbers } },
      { upsert: true }
    );
    console.log(`[DB-SETTINGS] Saved whitelist to MongoDB settings: ${numbers.join(',')}`);
  } catch (error) {
    console.error('[DB-SETTINGS] Error saving whitelist to MongoDB:', error);
  }
}

/**
 * Seed helper to copy ALLOWED_NUMBERS from .env into DB if it is empty
 */
async function seedWhitelistIfEmpty() {
  try {
    const existing = await getWhitelistFromDb();
    if (existing.length === 0) {
      const envAllowed = process.env.ALLOWED_NUMBERS || '';
      const numbers = envAllowed.split(',').map(n => n.trim()).filter(n => n.length > 0);
      if (numbers.length > 0) {
        console.log(`[DB-SETTINGS] Seeding database whitelist with .env numbers: ${numbers.join(',')}`);
        await saveWhitelistToDb(numbers);
      }
    }
  } catch (error) {
    console.error('[DB-SETTINGS] Error seeding whitelist:', error);
  }
}
