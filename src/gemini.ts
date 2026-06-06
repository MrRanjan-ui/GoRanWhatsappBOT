import { GoogleGenerativeAI } from '@google/generative-ai';
import * as fs from 'fs';
import * as path from 'path';

// Load config
const configPath = path.join(__dirname, '../config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

import * as dotenv from 'dotenv';
dotenv.config();

// Initialize Gemini SDK
const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

// Helper interface for chat message structure
export interface GeminiMessage {
  role: 'user' | 'model';
  parts: { text: string }[];
}

/**
 * Sends a message to the Gemini model with conversation history and a custom system instruction.
 * This is the main conversational endpoint — used for ALL user-facing responses.
 */
export async function askGemini(
  messageText: string,
  history: GeminiMessage[] = [],
  systemInstruction?: string
): Promise<string> {
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    return "⚠️ *GoRan AI System Note*: Gemini API Key is not configured in the bot server. Please tell the administrator to check the .env file.";
  }

  try {
    const instruction = (systemInstruction || config.systemInstruction) +
      "\n\nCRITICAL DIRECTIVE ON APPOINTMENTS: If the user asks to book an appointment, schedule a call, request a meeting, start a project, get a quote, or book a scoping call, you MUST reply with the exact text: `[TRIGGER_BOOKING]` and nothing else. Do not output the booking link. Let the system handle the booking flow directly in the chat.";

    const model = genAI.getGenerativeModel({
      model: 'gemini-flash-latest',
      systemInstruction: instruction
    });

    const chat = model.startChat({
      history: history
    });

    const result = await chat.sendMessage(messageText);
    const response = await result.response;
    return response.text().trim();
  } catch (error: any) {
    console.error('Error calling Gemini API:', error);
    return `❌ Sorry, I encountered an error while communicating with my AI brain: ${error.message || error}`;
  }
}

/**
 * Sends a raw prompt to Gemini WITHOUT conversation history.
 * Used for background tasks: data extraction, lead scoring, date parsing, etc.
 */
export async function askGeminiRaw(prompt: string): Promise<string> {
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new Error('Gemini API Key is not configured.');
  }

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-flash-latest'
    });

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text().trim();
  } catch (error: any) {
    console.error('Error calling Gemini API (raw):', error);
    throw error;
  }
}
