// src/firebaseClient.js
const admin = require('firebase-admin');
const { getVertexAI } = require('firebase-admin/vertexai');
const serviceAccount = require('../firebase-adminsdk.json'); // Your secure key

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Initialize the Gemini model via Firebase Vertex AI
const vertexAI = getVertexAI(admin.app());

// We use gemini-1.5-flash as it is the fastest for chatbot use cases
const generativeModel = vertexAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  generationConfig: {
    temperature: 0.3,
  }
});

module.exports = { generativeModel };