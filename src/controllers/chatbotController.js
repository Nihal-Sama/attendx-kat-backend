// ============================================================
//  controllers/chatbotController.js
//  Gemini Developer API via @google/generative-ai
//  Direct sequential pipeline — no LangGraph dependency.
// ============================================================
const { chat } = require('../services/geminiService');
const {
  getEmployeeContext,
  getAdminContext,
  getEmployeeByNameContext,
  parseDateRange,
} = require('../services/chatbotDataService');
const {
  generateAttendanceCSV,
  generateLeavesCSV,
  generateTasksCSV,
} = require('../services/reportService');

const VALID_INTENTS = [
  'attendance', 'leave', 'payroll', 'tasks',
  'employees',  'reports', 'productivity', 'out_of_scope',
];

const INTENT_SYSTEM = `
You are an intent classifier for an HR attendance system.
Classify the user message into ONE of:
attendance, leave, payroll, tasks, employees, reports, productivity, out_of_scope

Reply with ONLY the intent word. No punctuation, no explanation.
`.trim();


// ── Step 1: Classify intent ───────────────────────────────────
// ── Step 1: Classify intent ───────────────────────────────────
async function classifyIntent(message) {
  try {
    // We pass jsonMode: true to our Firebase Gemini service
    const rawJsonString = await chat(INTENT_SYSTEM, [], message, { jsonMode: true, temperature: 0 });
    
    // Parse the JSON safely
    const parsed = JSON.parse(rawJsonString);
    const intent = parsed.intent.trim().toLowerCase();

    return VALID_INTENTS.includes(intent) ? intent : 'out_of_scope';
  } catch (err) {
    console.error("Intent Classification Failed:", err);
    return 'out_of_scope';
  }
}


// ── Step 2: Fetch live data scoped to role ────────────────────
async function fetchData(user, message) {
  const dateRange = parseDateRange(message);

  if (user.role === 'employee') {
    return getEmployeeContext(user.id, dateRange);
  }

  const contextData = await getAdminContext(dateRange);

  const nameMatch = message.match(
    /(?:about|for|of|show me|details of|report for)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i
  );
  if (nameMatch?.[1]) {
    const specific = await getEmployeeByNameContext(nameMatch[1], dateRange);
    if (specific?.length > 0) contextData.specific_employee_context = specific;
  }

  return contextData;
}


// ── System prompt builder ─────────────────────────────────────
function buildSystemPrompt(role, data) {
  const base = `
You are AttendX Assistant, an AI integrated into AttendX, a Smart Employee Attendance Management System.
Your purpose is to help users understand their attendance data, leave records, tasks, and working hours.

STRICT RULES:
1. You ONLY answer questions related to: attendance, working hours, overtime, breaks, leaves, tasks, payroll estimates, and general HR/productivity topics.
2. If asked anything unrelated to work (poems, general knowledge, coding help, etc.), politely decline and redirect:
   "I can only assist with AttendX-related queries such as attendance, leaves, tasks, and working hours."
3. Allow general productivity questions such as how to write a leave application, what counts as overtime, etc.
4. Never reveal raw database IDs or internal system fields.
5. Always be professional, concise, and helpful.
6. When presenting data with multiple rows, use markdown tables for clarity.
7. When presenting a single metric, use plain prose.
8. Today's date is: ${data.today || new Date().toISOString().split('T')[0]}.
9. Current month: ${data.current_month || new Date().toISOString().slice(0, 7)}.
10. If you generate a report that could be downloaded, end your response with exactly this tag on its own line:
    [REPORT_AVAILABLE:attendance] or [REPORT_AVAILABLE:leaves] or [REPORT_AVAILABLE:tasks]
    Only include this tag when the user explicitly asks for a report, export, CSV, or download.
`.trim();

  if (role === 'employee') {
    const {
      profile, today_attendance, monthly_summary,
      attendance_records, leaves, tasks,
    } = data;

    return `${base}

ROLE: You are speaking with an EMPLOYEE. You can ONLY share data about this specific employee.
NEVER reveal or discuss any other employee's data under any circumstances.

EMPLOYEE PROFILE:
- Name: ${profile?.name || 'N/A'}
- Designation: ${profile?.designation || 'N/A'}
- Department: ${profile?.department || 'N/A'}
- Join Date: ${profile?.join_date || 'N/A'}
- Paid Leave Balance: ${(profile?.paid_leaves_total || 0) - (profile?.paid_leaves_used || 0)} days remaining of ${profile?.paid_leaves_total || 15} total

TODAY'S ATTENDANCE:
${today_attendance
  ? `- Status: ${today_attendance.status}
- Check In: ${today_attendance.check_in_time ? new Date(today_attendance.check_in_time).toLocaleTimeString() : 'Not yet'}
- Check Out: ${today_attendance.check_out_time ? new Date(today_attendance.check_out_time).toLocaleTimeString() : 'Not yet'}
- Hours Today: ${today_attendance.total_hours || 0}`
  : '- Not checked in today'}

THIS MONTH SUMMARY:
- Normal Hours: ${monthly_summary?.normal_hours || 0} / 180 target
- Overtime Hours: ${monthly_summary?.overtime_hours || 0}
- Total Hours: ${monthly_summary?.total_hours || 0}
- Present Days: ${monthly_summary?.present_days || 0}
- Absent Days: ${monthly_summary?.absent_days || 0}
- Leave Days: ${monthly_summary?.leave_days || 0}

ATTENDANCE RECORDS THIS MONTH (most recent first):
${(attendance_records || []).slice(0, 31).map(r =>
  `${r.date} | ${r.status} | In: ${r.check_in_time ? new Date(r.check_in_time).toLocaleTimeString() : '-'} | Out: ${r.check_out_time ? new Date(r.check_out_time).toLocaleTimeString() : '-'} | Normal: ${r.normal_hours}h | OT: ${r.overtime_hours}h`
).join('\n') || 'No records this month'}

LEAVE HISTORY (recent 20):
${(leaves || []).map(l =>
  `${l.type} | ${l.from_date} to ${l.to_date} | ${l.days} days | Status: ${l.status}`
).join('\n') || 'No leave history'}

TASKS ASSIGNED:
${(tasks || []).map(t =>
  `[${t.priority}] ${t.title} | Status: ${t.status} | Deadline: ${t.deadline ? new Date(t.deadline).toLocaleDateString() : 'N/A'} | Extension: ${t.ext_status}`
).join('\n') || 'No tasks assigned'}

PAYROLL ESTIMATE:
${profile?.monthly_salary
  ? `- Monthly Salary: ₹${profile.monthly_salary}
- Hourly Rate: ₹${(profile.monthly_salary / 180).toFixed(2)}
- Overtime Rate: ₹${(profile.monthly_salary / 180 * 1.5).toFixed(2)}/hr
- Estimated Earned This Month: ₹${(
      (Number(monthly_summary?.normal_hours || 0) * (profile.monthly_salary / 180)) +
      (Number(monthly_summary?.overtime_hours || 0) * (profile.monthly_salary / 180 * 1.5))
    ).toFixed(2)}`
  : '- Salary information not available'}`;
  }

  // Admin / CEO prompt
  const {
    employees, today_attendance, company_summary,
    leaves, tasks, pending_leaves, today_summary,
  } = data;

  const employeeList = (employees || [])
    .filter(e => e.role === 'employee')
    .map(e =>
      `- ${e.name} | ${e.designation || 'N/A'} | ${e.department || 'N/A'} | ` +
      `Leaves: ${e.paid_leaves_used}/${e.paid_leaves_total} used | ` +
      `Salary: ₹${e.monthly_salary || 'N/A'}`
    ).join('\n');

  const specificSection = (data.specific_employee_context || []).map(ec =>
    `\nDETAILED CONTEXT — ${ec.profile?.name || 'Employee'}:\n` +
    `- Designation: ${ec.profile?.designation || 'N/A'} | Department: ${ec.profile?.department || 'N/A'}\n` +
    `- This Month Hours: Normal ${ec.monthly_summary?.normal_hours}h | OT ${ec.monthly_summary?.overtime_hours}h | Total ${ec.monthly_summary?.total_hours}h\n` +
    `- Present: ${ec.monthly_summary?.present_days} | Absent: ${ec.monthly_summary?.absent_days} | Leave: ${ec.monthly_summary?.leave_days}\n` +
    `- Leave Balance: ${(ec.profile?.paid_leaves_total || 0) - (ec.profile?.paid_leaves_used || 0)} days remaining\n` +
    `- Tasks: ${ec.tasks?.length || 0} assigned`
  ).join('\n');

  return `${base}

ROLE: You are speaking with a ${role.toUpperCase()}. You have access to ALL employee data.
Note: CEO does not have personal attendance or leave tracking. Admin/CEO role is management-only.

COMPANY TODAY (${data.today}):
- Total Employees: ${today_summary?.total_employees || 0}
- Present: ${today_summary?.present || 0}
- Absent: ${today_summary?.absent || 0}
- Pending Leave Requests: ${pending_leaves || 0}

COMPANY MONTHLY SUMMARY (${data.current_month}):
- Total Normal Hours: ${company_summary?.total_normal_hours || 0}
- Total Overtime Hours: ${company_summary?.total_overtime_hours || 0}
- Total Hours Worked: ${company_summary?.total_hours_worked || 0}
- Total Present Records: ${company_summary?.total_present_days || 0}
- Total Absent Records: ${company_summary?.total_absent_days || 0}
- Total Leave Records: ${company_summary?.total_leave_days || 0}

ALL EMPLOYEES:
${employeeList || 'No employees found'}

TODAY'S ATTENDANCE RECORDS:
${(today_attendance || []).map(r =>
  `${r.users?.name || 'N/A'} | ${r.status} | ` +
  `In: ${r.check_in_time ? new Date(r.check_in_time).toLocaleTimeString() : '-'} | ` +
  `Out: ${r.check_out_time ? new Date(r.check_out_time).toLocaleTimeString() : '-'} | ` +
  `Normal: ${r.normal_hours}h | OT: ${r.overtime_hours}h`
).join('\n') || 'No attendance records today'}

LEAVE REQUESTS (recent 50):
${(leaves || []).map(l =>
  `${l.users?.name || 'N/A'} | ${l.type} | ${l.from_date} to ${l.to_date} | ` +
  `${l.days} days | Status: ${l.status}`
).join('\n') || 'No leave records'}

ALL TASKS:
${(tasks || []).map(t =>
  `[${t.priority}] ${t.title} | Assigned: ${t.assignee?.name || 'N/A'} | ` +
  `Status: ${t.status} | Deadline: ${t.deadline ? new Date(t.deadline).toLocaleDateString() : 'N/A'} | ` +
  `Extension: ${t.ext_status}`
).join('\n') || 'No tasks'}
${specificSection}`;
}


// ── Step 3: Generate reply ────────────────────────────────────
async function generateReply(user, message, history, contextData) {
  const systemPrompt = buildSystemPrompt(user.role, contextData);
  return chat(systemPrompt, history, message, { maxTokens: 1000, temperature: 0.3 });
}


// ── Step 4: Parse report tag and build CSV if flagged ─────────
function buildReport(user, rawReply, contextData) {
  const reportMatch = rawReply.match(/\[REPORT_AVAILABLE:(\w+)\]/);
  const reportType  = reportMatch ? reportMatch[1] : null;
  const cleanReply  = rawReply.replace(/\[REPORT_AVAILABLE:\w+\]\n?/g, '').trim();

  if (!reportType) return { cleanReply, report: null };

  let report = null;

  if (reportType === 'attendance') {
    const records = user.role === 'employee'
      ? (contextData.attendance_records || []).map(r => ({
          ...r, users: { name: contextData.profile?.name },
        }))
      : (contextData.month_attendance || []);
    report = {
      type:     'csv',
      filename: `attendance_report_${contextData.current_month}.csv`,
      content:  generateAttendanceCSV(records, `Attendance Report — ${contextData.current_month}`),
    };
  } else if (reportType === 'leaves') {
    const leaves = user.role === 'employee'
      ? (contextData.leaves || []).map(l => ({
          ...l, users: { name: contextData.profile?.name },
        }))
      : (contextData.leaves || []);
    report = {
      type:     'csv',
      filename: `leave_report_${contextData.current_month}.csv`,
      content:  generateLeavesCSV(leaves, `Leave Report — ${contextData.current_month}`),
    };
  } else if (reportType === 'tasks') {
    report = {
      type:     'csv',
      filename: `tasks_report_${contextData.today}.csv`,
      content:  generateTasksCSV(contextData.tasks || [], 'Tasks Report'),
    };
  }

  return { cleanReply, report };
}


// ── POST /api/chatbot/message ─────────────────────────────────
async function sendMessage(req, res) {
  try {
    const { message, history = [] } = req.body;
    const user = req.user;

    if (!message || typeof message !== 'string' || !message.trim())
      return res.status(400).json({ error: 'Message is required.' });
    if (message.trim().length > 1000)
      return res.status(400).json({ error: 'Message is too long. Maximum 1000 characters.' });
    if (!Array.isArray(history))
      return res.status(400).json({ error: 'history must be an array.' });

    const validHistory = history.filter(h =>
      h &&
      typeof h === 'object' &&
      (h.role === 'user' || h.role === 'assistant') &&
      typeof h.content === 'string'
    );

    // Step 1 — classify intent
    const intent = await classifyIntent(message.trim());

    // Step 2 — block immediately if out of scope
    if (intent === 'out_of_scope') {
      return res.status(200).json({
        reply:  'I can only assist with AttendX-related queries such as attendance, leaves, tasks, and working hours.',
        report: null,
      });
    }

    // Step 3 — fetch live Supabase data scoped to role
    const contextData = await fetchData(user, message.trim());

    // Step 4 — generate AI reply
    const rawReply = await generateReply(user, message.trim(), validHistory, contextData);

    // Step 5 — parse report tag and build CSV
    const { cleanReply, report } = buildReport(user, rawReply, contextData);

    return res.status(200).json({
      reply:  cleanReply || 'I was unable to generate a response. Please try again.',
      report: report || null,
    });

  } catch (err) {
    console.error('[chatbotController.sendMessage]', err);

    if (err.message?.includes('API_KEY') || err.message?.includes('api key')) {
      return res.status(500).json({
        error: 'AI service configuration error. Please contact your administrator.',
      });
    }
    if (err.message?.includes('quota') || err.message?.includes('rate')) {
      return res.status(429).json({
        error: 'AI service is temporarily busy. Please try again in a moment.',
      });
    }

    return res.status(500).json({ error: 'Failed to get a response. Please try again.' });
  }
}


module.exports = { sendMessage };