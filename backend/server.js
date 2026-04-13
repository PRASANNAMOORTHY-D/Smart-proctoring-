/**
 * ProctorAI — Backend Server
 * Express REST API + Socket.io for real-time multi-student proctoring
 *
 * Endpoints
 * ─────────────────────────────────────────────────────
 * POST /api/auth/login          — Login (student or admin)
 * POST /api/auth/register       — Register new user
 * GET  /api/users               — List all users          [admin]
 * GET  /api/exams               — List all exams
 * POST /api/exams               — Create exam             [admin]
 * PUT  /api/exams/:id           — Update exam             [admin]
 * DELETE /api/exams/:id         — Delete exam             [admin]
 * GET  /api/students            — List live students      [admin]
 * POST /api/students            — Add student manually    [admin]
 * POST /api/reports             — Submit exam report      [student]
 * GET  /api/reports             — List all reports        [admin]
 * GET  /api/messages/:sid       — Get conversation        [admin]
 * POST /api/messages/:sid       — Send message            [admin]
 *
 * Socket.io Events (server → client)
 * ─────────────────────────────────────────────────────
 * admin:feed          — Live alert feed entry
 * admin:student-join  — Student joined exam
 * admin:student-update— Student status/score changed
 * admin:report        — New exam report received
 * student:message     — Admin sent a message to student
 * student:warning     — Admin issued a warning
 * student:terminate   — Admin terminated the session
 *
 * Socket.io Events (client → server)
 * ─────────────────────────────────────────────────────
 * student:violation   — Student violation detected
 * student:heartbeat   — Keep-alive + integrity score
 */

'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const { v4: uuid } = require('uuid');
const path       = require('path');

// ═══════════════════════════════════════════════════════
//  APP SETUP
// ═══════════════════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST','PUT','DELETE'] }
});

app.use(cors());
app.use(express.json());

// Serve the frontend from ../frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// ═══════════════════════════════════════════════════════
//  IN-MEMORY DATABASE  (swap for MongoDB/SQLite in prod)
// ═══════════════════════════════════════════════════════
const DB = {
  users: [
    { id:'u1', email:'priya@student.edu',   password:'Student@123', role:'student', name:'Priya Sharma',    sid:'STU001', dept:'Computer Science', registeredAt: new Date().toISOString() },
    { id:'u2', email:'arjun@student.edu',   password:'Student@123', role:'student', name:'Arjun Mehta',     sid:'STU002', dept:'Computer Science', registeredAt: new Date().toISOString() },
    { id:'u3', email:'kavya@student.edu',   password:'Student@123', role:'student', name:'Kavya Reddy',     sid:'STU003', dept:'Information Technology', registeredAt: new Date().toISOString() },
    { id:'u4', email:'admin@proctorai.edu', password:'Admin@123',   role:'admin',   name:'Dr. Ramesh Kumar',sid:'ADM001', dept:'Administration',    registeredAt: new Date().toISOString() },
  ],
  exams: [
    { id:'ex1', title:'Computer Science Final Exam',   code:'CS401-FINAL-2025',  subject:'Computer Science',    dur:60, marks:100, pass:40, active:true,  students:0, desc:'End semester — DS, Algorithms, OS' },
    { id:'ex2', title:'Software Engineering Mid-Sem',  code:'SE301-MID-2025',    subject:'Software Engineering', dur:45, marks:50,  pass:20, active:true,  students:0, desc:'Design patterns, SDLC, Agile' },
    { id:'ex3', title:'DBMS Internal Assessment',      code:'DB201-INT-2025',    subject:'Database Management',  dur:30, marks:30,  pass:12, active:false, students:0, desc:'SQL, Normalization, Transactions' },
  ],
  // Live exam sessions (populated when students join)
  liveSessions: {},  // sid → { sid, name, dept, intScore, violations, status, socketId, joinedAt }
  reports: [],
  messages: {},      // sid → [ { from, text, time } ]
};

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════
function findUser(email, password, role) {
  return DB.users.find(u => u.email === email && u.password === password && u.role === role);
}
function sanitizeUser(u) {
  const { password, ...safe } = u;
  return safe;
}

// Broadcast to all connected admins
function broadcastAdmin(event, data) {
  io.to('admins').emit(event, data);
}

// ═══════════════════════════════════════════════════════
//  REST — AUTH
// ═══════════════════════════════════════════════════════
app.post('/api/auth/login', (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || !role)
    return res.status(400).json({ error: 'email, password and role are required' });

  const user = findUser(email.trim().toLowerCase(), password, role);
  if (!user) return res.status(401).json({ error: 'Invalid credentials or wrong role' });

  user.lastLogin = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  res.json({ ok: true, user: sanitizeUser(user) });
});

app.post('/api/auth/register', (req, res) => {
  const { firstName, lastName, email, sid, dept, password, role, adminCode } = req.body;
  if (!firstName || !lastName || !email || !sid || !password || !role)
    return res.status(400).json({ error: 'All fields are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (role === 'admin' && adminCode !== 'ADMIN2025')
    return res.status(403).json({ error: 'Invalid admin access code' });

  const em = email.trim().toLowerCase();
  if (DB.users.find(u => u.email === em))
    return res.status(409).json({ error: 'Email already registered' });

  const newUser = {
    id: uuid(), email: em, password, role,
    name: `${firstName} ${lastName}`, sid, dept,
    registeredAt: new Date().toISOString()
  };
  DB.users.push(newUser);

  // Notify any connected admin
  broadcastAdmin('admin:feed', {
    msg: `✅ New ${role} registered: ${newUser.name} (${sid})`,
    type: 'safe', time: new Date().toLocaleTimeString()
  });

  res.status(201).json({ ok: true, user: sanitizeUser(newUser) });
});

// ═══════════════════════════════════════════════════════
//  REST — USERS
// ═══════════════════════════════════════════════════════
app.get('/api/users', (req, res) => {
  res.json(DB.users.map(sanitizeUser));
});

// ═══════════════════════════════════════════════════════
//  REST — EXAMS
// ═══════════════════════════════════════════════════════
app.get('/api/exams', (req, res) => {
  res.json(DB.exams);
});

app.post('/api/exams', (req, res) => {
  const { title, code, subject, dur, marks, pass, desc } = req.body;
  if (!title || !code) return res.status(400).json({ error: 'title and code required' });
  if (DB.exams.find(e => e.code === code))
    return res.status(409).json({ error: 'Duplicate exam code' });

  const ex = { id: uuid(), title, code, subject: subject||'General', dur: dur||60,
               marks: marks||100, pass: pass||40, active: true, students: 0, desc: desc||'', createdAt: new Date().toISOString() };
  DB.exams.push(ex);
  broadcastAdmin('admin:feed', { msg:`📝 Exam created: "${title}"`, type:'safe', time: new Date().toLocaleTimeString() });
  res.status(201).json(ex);
});

app.put('/api/exams/:id', (req, res) => {
  const ex = DB.exams.find(e => e.id === req.params.id);
  if (!ex) return res.status(404).json({ error: 'Exam not found' });
  Object.assign(ex, req.body);
  broadcastAdmin('admin:feed', { msg:`✏ Exam updated: "${ex.title}"`, type:'safe', time: new Date().toLocaleTimeString() });
  res.json(ex);
});

app.delete('/api/exams/:id', (req, res) => {
  const idx = DB.exams.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Exam not found' });
  const [ex] = DB.exams.splice(idx, 1);
  broadcastAdmin('admin:feed', { msg:`🗑 Exam deleted: "${ex.title}"`, type:'danger', time: new Date().toLocaleTimeString() });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════
//  REST — LIVE STUDENTS
// ═══════════════════════════════════════════════════════
app.get('/api/students', (req, res) => {
  res.json(Object.values(DB.liveSessions));
});

app.post('/api/students', (req, res) => {
  // Admin manually adds a student account
  const { firstName, lastName, email, sid, dept, password } = req.body;
  if (!firstName || !lastName || !email || !sid || !password)
    return res.status(400).json({ error: 'All fields required' });
  if (DB.users.find(u => u.email === email.trim().toLowerCase()))
    return res.status(409).json({ error: 'Email already registered' });

  const newUser = {
    id: uuid(), email: email.trim().toLowerCase(), password, role: 'student',
    name: `${firstName} ${lastName}`, sid, dept: dept||'General',
    registeredAt: new Date().toISOString()
  };
  DB.users.push(newUser);
  DB.messages[sid] = [];
  broadcastAdmin('admin:feed', { msg:`✓ Student added: ${newUser.name}`, type:'safe', time: new Date().toLocaleTimeString() });
  res.status(201).json({ ok: true, user: sanitizeUser(newUser) });
});

// ═══════════════════════════════════════════════════════
//  REST — REPORTS
// ═══════════════════════════════════════════════════════
app.get('/api/reports', (req, res) => {
  res.json(DB.reports);
});

app.post('/api/reports', (req, res) => {
  const report = {
    ...req.body,
    reportId: 'RPT-' + Date.now(),
    receivedAt: new Date().toLocaleTimeString(),
    riskScore: 100 - (req.body.intScore || 100),
    riskLevel: (100-(req.body.intScore||100)) >= 60 ? 'HIGH RISK'
             : (100-(req.body.intScore||100)) >= 30 ? 'MEDIUM RISK' : 'LOW RISK',
  };
  DB.reports.push(report);

  // Broadcast to admin in real-time
  broadcastAdmin('admin:report', report);
  broadcastAdmin('admin:feed', {
    msg: `📨 Report received: ${report.name} — Risk: ${report.riskLevel} (${report.riskScore}/100)`,
    type: 'info', time: new Date().toLocaleTimeString()
  });

  // Remove from live sessions
  if (DB.liveSessions[report.id]) {
    DB.liveSessions[report.id].status = 'submitted';
    broadcastAdmin('admin:student-update', DB.liveSessions[report.id]);
  }

  res.status(201).json({ ok: true, reportId: report.reportId });
});

// ═══════════════════════════════════════════════════════
//  REST — MESSAGES
// ═══════════════════════════════════════════════════════
app.get('/api/messages/:sid', (req, res) => {
  res.json(DB.messages[req.params.sid] || []);
});

app.post('/api/messages/:sid', (req, res) => {
  const { text } = req.body;
  const { sid } = req.params;
  if (!text) return res.status(400).json({ error: 'text required' });

  const msg = { from: 'admin', text, time: new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) };
  if (!DB.messages[sid]) DB.messages[sid] = [];
  DB.messages[sid].push(msg);

  // Push to student's socket if online
  const session = DB.liveSessions[sid];
  if (session && session.socketId) {
    io.to(session.socketId).emit('student:message', msg);
  }

  broadcastAdmin('admin:feed', {
    msg: `✉ Message sent to ${session?.name || sid}`,
    type: 'safe', time: new Date().toLocaleTimeString()
  });

  res.json({ ok: true });
});

// Catch-all — serve index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ═══════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════
io.on('connection', socket => {
  console.log(`[Socket] connected: ${socket.id}`);

  // ── Admin joins the "admins" room ──
  socket.on('admin:join', ({ adminName }) => {
    socket.join('admins');
    console.log(`[Socket] Admin joined: ${adminName}`);
    // Send current live sessions snapshot
    socket.emit('admin:snapshot', {
      students: Object.values(DB.liveSessions),
      reports:  DB.reports.slice(-20),
    });
  });

  // ── Student joins an exam session ──
  socket.on('student:join', ({ sid, name, dept, examCode }) => {
    const session = {
      id: sid, name, dept,
      intScore: 100,
      riskScore: 0,
      violations: [],
      status: 'active',
      socketId: socket.id,
      examCode,
      joinedAt: new Date().toLocaleTimeString(),
    };
    DB.liveSessions[sid] = session;
    if (!DB.messages[sid]) DB.messages[sid] = [];

    socket.join(`student:${sid}`);

    broadcastAdmin('admin:student-join', session);
    broadcastAdmin('admin:feed', {
      msg: `🎓 Student joined: ${name} (${sid}) — Exam: ${examCode}`,
      type: 'info', time: new Date().toLocaleTimeString()
    });

    console.log(`[Socket] Student joined: ${name} (${sid})`);
  });

  // ── Student violation event ──
  socket.on('student:violation', ({ sid, violation }) => {
    const session = DB.liveSessions[sid];
    if (!session) return;

    session.violations.push(violation);
    session.intScore  = Math.max(0, session.intScore - (violation.deduct || 5));
    session.riskScore = 100 - session.intScore;

    if (session.violations.length >= 5 && session.status === 'active')
      session.status = 'suspicious';
    if (session.violations.filter(v => v.sev === 'crit').length >= 2)
      session.status = 'flagged';

    broadcastAdmin('admin:student-update', session);
    // Also broadcast a targeted violation event so admin card AI panels update instantly
    broadcastAdmin('admin:violation', {
      sid,
      violation,
      intScore: session.intScore,
    });
    broadcastAdmin('admin:feed', {
      msg: `⚠ ${violation.icon||'⚠'} ${session.name}: ${violation.text}`,
      type: violation.sev === 'crit' ? 'danger' : 'warn',
      time: new Date().toLocaleTimeString()
    });
  });

  // ── Student heartbeat (periodic integrity update) ──
  socket.on('student:heartbeat', ({ sid, intScore }) => {
    const session = DB.liveSessions[sid];
    if (!session) return;
    session.intScore  = intScore;
    session.riskScore = 100 - intScore;
    broadcastAdmin('admin:student-update', { id: sid, intScore, riskScore: 100 - intScore });
  });

  // ── Student AI state — face conf, gaze, objects, audio (pushed every ~2s) ──
  // Broadcasts to all admins so card AI panels update in real-time
  socket.on('student:ai-state', ({ sid, aiState }) => {
    const session = DB.liveSessions[sid];
    if (!session) return;
    session.aiState = aiState;
    broadcastAdmin('admin:ai-state', { id: sid, aiState });
  });

  // ══════════════════════════════════════════════════════
  //  WEBRTC SIGNALING — routes SDP/ICE between student
  //  and admin without the server touching media at all.
  //  Flow: admin requests offer → student sends offer →
  //        admin sends answer → ICE candidates exchanged
  // ══════════════════════════════════════════════════════

  // Admin wants to view a student's camera — asks student to create an offer
  socket.on('webrtc:request-offer', ({ sid }) => {
    const session = DB.liveSessions[sid];
    if (!session || !session.socketId) return;
    // Forward the request to the specific student
    io.to(session.socketId).emit('webrtc:request-offer', {
      adminSocketId: socket.id,
    });
    console.log(`[WebRTC] Admin ${socket.id} requested offer from student ${sid}`);
  });

  // Student sends SDP offer → forward to the requesting admin
  socket.on('webrtc:offer', ({ adminSocketId, sid, sdp }) => {
    io.to(adminSocketId).emit('webrtc:offer', { sid, sdp });
    console.log(`[WebRTC] Offer from student ${sid} → admin ${adminSocketId}`);
  });

  // Admin sends SDP answer → forward to the student
  socket.on('webrtc:answer', ({ sid, sdp }) => {
    const session = DB.liveSessions[sid];
    if (!session || !session.socketId) return;
    io.to(session.socketId).emit('webrtc:answer', {
      adminSocketId: socket.id,
      sdp,
    });
    console.log(`[WebRTC] Answer from admin → student ${sid}`);
  });

  // ICE candidates — relay in both directions
  socket.on('webrtc:ice-candidate', ({ target, sid, candidate }) => {
    if (target === 'admin') {
      // Student → Admin
      broadcastAdmin('webrtc:ice-candidate', { sid, candidate });
    } else {
      // Admin → Student
      const session = DB.liveSessions[sid];
      if (session && session.socketId) {
        io.to(session.socketId).emit('webrtc:ice-candidate', {
          adminSocketId: socket.id, candidate,
        });
      }
    }
  });

  // Student disconnected from WebRTC (exam ended / tab closed)
  socket.on('webrtc:stop', ({ sid }) => {
    broadcastAdmin('webrtc:stop', { sid });
    console.log(`[WebRTC] Student ${sid} stopped stream`);
  });

  // Student signals they are ready to stream camera to admins
  // Server relays this to all admins so they can request an offer
  socket.on('webrtc:ready', ({ sid }) => {
    console.log(`[WebRTC] Student ${sid} is ready to stream`);
    broadcastAdmin('webrtc:student-ready', { sid });
  });

  // ── Admin actions ──
  socket.on('admin:action', ({ action, sid }) => {
    const session = DB.liveSessions[sid];
    if (!session) return;

    if (action === 'warn') {
      io.to(`student:${sid}`).emit('student:warning', { text: 'The proctor has issued a formal warning. Continue ethically.' });
      broadcastAdmin('admin:feed', { msg:`⚠ Warning sent to ${session.name}`, type:'warn', time: new Date().toLocaleTimeString() });
    } else if (action === 'terminate') {
      session.status = 'flagged';
      io.to(`student:${sid}`).emit('student:terminate', { reason: 'Your exam session has been terminated by the proctor due to integrity violations.' });
      broadcastAdmin('admin:student-update', session);
      broadcastAdmin('admin:feed', { msg:`🚫 Session terminated: ${session.name}`, type:'danger', time: new Date().toLocaleTimeString() });
    } else if (action === 'clear') {
      session.status = 'active';
      broadcastAdmin('admin:student-update', session);
      broadcastAdmin('admin:feed', { msg:`✓ Flag cleared: ${session.name}`, type:'safe', time: new Date().toLocaleTimeString() });
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    // Mark any live session as disconnected
    const session = Object.values(DB.liveSessions).find(s => s.socketId === socket.id);
    if (session && session.status !== 'submitted') {
      session.status = 'disconnected';
      broadcastAdmin('admin:student-update', session);
      broadcastAdmin('admin:feed', {
        msg: `⚡ ${session.name} disconnected`,
        type: 'warn', time: new Date().toLocaleTimeString()
      });
    }
    console.log(`[Socket] disconnected: ${socket.id}`);
  });
});

// ═══════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🟢  ProctorAI backend running on http://localhost:${PORT}`);
  console.log(`    REST API  →  http://localhost:${PORT}/api`);
  console.log(`    Frontend  →  http://localhost:${PORT}/\n`);
});
