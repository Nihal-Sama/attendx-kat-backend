// ============================================================
//  AttendX — Express Server Entry Point
// ============================================================
require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');

const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'IMAGEKIT_PUBLIC_KEY',
  'IMAGEKIT_PRIVATE_KEY',
  'IMAGEKIT_URL_ENDPOINT',
];

const missingEnvVars = requiredEnvVars.filter((name) => !process.env[name]);
if (missingEnvVars.length > 0) {
  console.error(
    'Missing required environment variables for backend startup:',
    missingEnvVars.join(', ')
  );
  process.exit(1);
}

// Route imports
const screenshotRoutes   = require('./routes/screenshotRoutes');
const authRoutes         = require('./routes/authRoutes');
const userRoutes         = require('./routes/userRoutes');
const attendanceRoutes   = require('./routes/attendanceRoutes');
const leaveRoutes        = require('./routes/leaveRoutes');
const chatRoutes         = require('./routes/chatRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const dashboardRoutes    = require('./routes/dashboardRoutes');
const imagekitRoutes     = require('./routes/imagekitRoutes');  // ← NEW
const taskRoutes         = require('./routes/taskRoutes');
const chatbotRoutes      = require('./routes/chatbotRoutes');

// Cron job
require('./jobs/markAbsent');
require('./jobs/deleteOldScreenshots'); 
const app = express();

// ── Security middleware ──────────────────────────────────────
app.use(helmet());

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://attendx11-sigma.vercel.app',
  'http://localhost:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS origin denied: ${origin}`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// ── Rate limiting on auth routes only ───────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Body parsing ─────────────────────────────────────────────
// express.json() is now sufficient for all routes.
// multer is no longer needed at the server level.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Routes ───────────────────────────────────────────────────
app.use('/api/auth',          authLimiter, authRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/attendance',    attendanceRoutes);
app.use('/api/leaves',        leaveRoutes);
app.use('/api/chat',          chatRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/screenshots',   screenshotRoutes);
app.use('/api/imagekit',      imagekitRoutes);   // ← NEW
app.use('/api/tasks',         taskRoutes);
app.use('/api/chatbot',       chatbotRoutes);
// ── Root / health checks ─────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', app: 'AttendX API' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', app: 'AttendX API' }));

// ── 404 handler ───────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Global error handler ──────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Error]', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅  AttendX API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});