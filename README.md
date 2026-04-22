# AttendX Backend

Node.js / Express backend for the AttendX Smart Attendance Management System.

## Stack
- **Runtime**: Node.js v18+ LTS
- **Framework**: Express.js
- **Database**: Supabase (PostgreSQL 15)
- **Photo Storage**: ImageKit
- **Auth**: Supabase Auth (JWT)
- **Realtime**: Supabase Realtime (chat + notifications)
- **Scheduler**: node-cron (nightly absent job)

---

## Setup Instructions

### Step 1 — Supabase Database
1. Go to your Supabase project → SQL Editor
2. Paste and run `ATTENDX_DATABASE.sql` (the full provisioning script)
3. Paste and run `ATTENDX_RPC.sql` (the atomic increment function)
4. Go to **Database → Replication** → enable Realtime on:
   - `messages` table
   - `notifications` table
5. Go to **Authentication → Providers** → confirm Email/Password is ON

### Step 2 — Environment Variables
```bash
cp .env.example .env
```
Fill in your real values in `.env`:
- `SUPABASE_URL` and keys from: Project Settings → API
- `IMAGEKIT_*` keys from: ImageKit Dashboard → Developer Options

### Step 3 — Install Dependencies
```bash
npm install
```

### Step 4 — Run the Server
```bash
# Development (auto-restart on file changes)
npm run dev

# Production
npm start
```
Server starts on `http://localhost:4000`

### Step 5 — Health Check
```
GET http://localhost:4000/health
```
Should return: `{ "status": "ok", "app": "AttendX API" }`

---

## API Endpoints

### Auth
| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| POST | `/api/auth/login` | Public | Login with email + password |
| POST | `/api/auth/logout` | Auth | Logout |
| GET | `/api/auth/me` | Auth | Get current user |
| PATCH | `/api/auth/reset-password` | Auth | Reset password (first login) |

### Users
| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/users` | Admin/CEO | List all active users |
| POST | `/api/users` | Admin/CEO | Create new user |
| GET | `/api/users/:id` | Self/Admin/CEO | Get user profile |
| PUT | `/api/users/:id` | Self/Admin/CEO | Update user |
| DELETE | `/api/users/:id` | Admin/CEO | Deactivate user |

### Attendance
| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| POST | `/api/attendance/checkin` | Employee | Check in (multipart/form-data, photo optional) |
| POST | `/api/attendance/checkout` | Employee | Check out (multipart/form-data, photo optional) |
| POST | `/api/attendance/break/start` | Employee | Start break |
| POST | `/api/attendance/break/end` | Employee | End break |
| GET | `/api/attendance/today` | Auth | Today's record |
| GET | `/api/attendance/summary` | Auth | Monthly hours summary |
| GET | `/api/attendance/history` | Employee | Own history (?month=YYYY-MM) |
| GET | `/api/attendance/all` | Admin/CEO | All employees today |
| GET | `/api/attendance/report` | Admin/CEO | Monthly report (?month=, ?user_id=) |
| PATCH | `/api/attendance/:id` | Admin/CEO | Manual override |

### Leaves
| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| POST | `/api/leaves` | Auth | Apply for leave |
| GET | `/api/leaves` | Auth | List leaves (own or all) |
| GET | `/api/leaves/:id` | Auth | Get leave detail |
| PATCH | `/api/leaves/:id/approve` | CEO only | Approve leave |
| PATCH | `/api/leaves/:id/reject` | CEO only | Reject leave |
| DELETE | `/api/leaves/:id` | Auth | Cancel own pending leave |

### Chat
| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/chat/messages` | Auth | Get messages (?page=1&limit=50) |
| POST | `/api/chat/messages` | Auth | Send message |
| DELETE | `/api/chat/messages/:id` | Auth | Soft-delete message |

### Notifications
| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/notifications` | Auth | Get own notifications |
| PATCH | `/api/notifications/read-all` | Auth | Mark all as read |
| PATCH | `/api/notifications/:id/read` | Auth | Mark one as read |

### Dashboard
| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/dashboard/me` | Auth | Own stats |
| GET | `/api/dashboard/overview` | Admin/CEO | Company-wide stats |

---

## Photo Upload (Check-in / Check-out)
Send as `multipart/form-data`:
```
POST /api/attendance/checkin
Content-Type: multipart/form-data

Fields:
  photo  (file, optional) — JPEG/PNG, max 5MB
  lat    (string, optional) — GPS latitude
  lng    (string, optional) — GPS longitude
```

---

## Important Notes

1. **Leave approval** — always update `status + reviewed_by + reviewed_at` in ONE call.
   The DB constraint `chk_reviewed_fields` will reject partial updates.

2. **service_role key** — used by this server, bypasses RLS. Never expose it to frontend.

3. **Realtime** — the frontend subscribes to Supabase Realtime directly for chat and
   notifications. This server only handles REST. No WebSocket server needed here.

4. **Cron job** — `markAbsent.js` runs at 23:55 on weekdays. If hosting on a serverless
   platform that sleeps (e.g. Render free tier), the cron may not fire reliably.
   Use Supabase pg_cron as an alternative.
