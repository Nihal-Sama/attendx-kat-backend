// src/services/geminiService.js
const { generativeModel } = require('../firebaseClient');

/**
 * Executes a chat request via Google Cloud Vertex AI (Gemini).
 * @param {string} systemInstruction - The context and rules for the AI.
 * @param {Array} history - Previous chat messages [{ role, content }].
 * @param {string} message - The new user message.
 * @param {Object} options - Configuration options (temperature, JSON mode, etc).
 * @returns {Promise<string>} - The AI's text response.
 */
async function chat(systemInstruction, history = [], message, options = {}) {
  try {
    // 1. Format the history to match Vertex AI's expected structure
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

    // 3. Send the message (Cloud SDK requires an array of parts)
    const result = await chatSession.sendMessage([{ text: message }]);
    
    // 4. Safely extract text from the Vertex AI payload
    if (result.response.candidates && result.response.candidates[0].content.parts.length > 0) {
      return result.response.candidates[0].content.parts[0].text;
    }
    
    // Fallback logic
    return result.response.text ? result.response.text() : "";

  } catch (error) {
    console.error('[Firebase Vertex AI Service Error]:', error);
    throw error;
  }
}

module.exports = { chat };