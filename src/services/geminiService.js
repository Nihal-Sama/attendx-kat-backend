// src/services/geminiService.js
const { generativeModel } = require('../firebaseClient');

/**
 * Executes a chat request via Firebase Vertex AI (Gemini).
 * * @param {string} systemInstruction - The context and rules for the AI.
 * @param {Array} history - Previous chat messages [{ role, content }].
 * @param {string} message - The new user message.
 * @param {Object} options - Configuration options (temperature, JSON mode, etc).
 * @returns {Promise<string>} - The AI's text response.
 */
async function chat(systemInstruction, history = [], message, options = {}) {
  try {
    // 1. Format the history to match Firebase's expected structure
    // Firebase Gemini uses 'model' instead of 'assistant' for the AI role.
    // We also slice the history to the last 10 turns to prevent token bloat.
    const formattedHistory = history.slice(-10).map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    }));

    // 2. Configure the chat session with the system prompt
    const chatSession = generativeModel.startChat({
      history: formattedHistory,
      systemInstruction: { parts: [{ text: systemInstruction }] },
      generationConfig: {
        temperature: options.temperature ?? 0.3,
        // If the intent classifier calls this, enforce JSON output
        ...(options.jsonMode && {
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: { intent: { type: "string" } },
            required: ["intent"]
          }
        })
      }
    });

    // 3. Send the message and extract the text
    const result = await chatSession.sendMessage(message);
    return result.response.text();

  } catch (error) {
    console.error('[Firebase Gemini Service Error]:', error);
    throw error;
  }
}

module.exports = { chat };