const admin = require('firebase-admin');
const { VertexAI } = require('@google-cloud/vertexai');
const path = require('path');
const fs = require('fs');

// 1. Locate the Service Account Key (Securely injected by Render)
const keyPath = path.join(__dirname, '../firebase-adminsdk.json');

if (!fs.existsSync(keyPath)) {
  console.error('🚨 Missing required Firebase Service Account key (firebase-adminsdk.json)');
  process.exit(1);
}

const serviceAccount = require(keyPath);

// 2. Initialize Firebase Admin (for Auth, Database, etc.)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// 3. Initialize the dedicated Server-Side Vertex AI SDK
const vertexAI = new VertexAI({
  project: serviceAccount.project_id,
  location: 'us-central1', // Default region for Gemini 1.5 Flash
  keyFilename: keyPath
});

const generativeModel = vertexAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  generationConfig: {
    temperature: 0.3,
  }
});

module.exports = { generativeModel };