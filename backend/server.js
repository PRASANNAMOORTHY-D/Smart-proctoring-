/**
 * ProctorAI — Backend Server with MySQL Database
 *
 * SETUP:
 *   1. Run: npm install mysql2
 *   2. Run the SQL schema file: proctorai_schema.sql
 *   3. Update DB_CONFIG below with your MySQL credentials
 *   4. npm start
 */

'use strict';

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const cors         = require('cors');
const { v4: uuid } = require('uuid');
const path         = require('path');
const mysql        = require('mysql2/promise');

// ═══════════════════════════════════════════════════════
//  MYSQL CONNECTION CONFIG — update these values
// ═══════════════════════════════════════════════════════
const DB_CONFIG = {
  host:     'mysql-2b2f4e82-project-415e.c.aivencloud.com',
  port:     22148,
  user:     'root',          // your MySQL username
  password: 'avnadmin', // your MySQL password
  database: 'defaultdb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

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
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Create MySQL connection pool ──
let pool;
(async () => {
  try {
    pool = mysql.createPool(DB_CONFIG);
    // Test the connection
    const conn = await pool.getConnection();
    console.log('✅ MySQL connected to proctorai_db');
    conn.release();
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message);
    console.error('   Check DB_CONFIG credentials and make sure MySQL is running.');
    process.exit(1);
  }
})();

// ═══════════════════════════════════════════════════════
//  IN-MEMORY STORE for live exam sessions (not persisted)
//  Violations and reports ARE persisted to MySQL.
// ═══════════════════════════════════════════════════════
const liveSessions = {};  // sid → session object

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════
function sanitizeUser(u) {
  const { password, ...safe } = u;
  return safe;
}

function broadcastAdmin(event, data) {
  io.to('admins').emit(event, data);
}

// ═══════════════════════════════════════════════════════
//  REST — AUTH
// ═══════════════════════════════════════════════════════

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || !role)
    return res.status(400).json({ error: 'email, password and role are required' });

  try {
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE email = ? AND password = ? AND role = ?',
      [email.trim().toLowerCase(), password, role]
    );

    if (rows.length === 0)
      return res.status(401).json({ error: 'Invalid credentials or wrong role selected' });

    const user = rows[0];

    // Update last_login timestamp
    await pool.query(
      'UPDATE users SET last_login = NOW() WHERE id = ?',
      [user.id]
    );

    console.log(`[Auth] Login: ${user.name} (${user.role})`);
    res.json({ ok: true, user: sanitizeUser(user) });

  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ error: 'Database error during login' });
  }
});

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { firstName, lastName, email, sid, dept, password, role, adminCode } = req.body;

  if (!firstName || !lastName || !email || !sid || !password || !role)
    return res.status(400).json({ error: 'All fields are required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (role === 'admin' && adminCode !== 'ADMIN2025')
    return res.status(403).json({ error: 'Invalid admin access code' });

  const em = email.trim().toLowerCase();

  try {
    // Check if email already exists
    const [existing] = await pool.query(
      'SELECT id FROM users WHERE email = ? OR sid = ?',
      [em, sid]
    );
    if (existing.length > 0)
      return res.status(409).json({ error: 'Email or Student ID already registered' });

    const newId = uuid();
    const fullName = `${firstName} ${lastName}`;

    await pool.query(
      `INSERT INTO users (id, email, password, role, name, sid, dept)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId, em, password, role, fullName, sid, dept || 'General']
    );

    const newUser = { id: newId, email: em, role, name: fullName, sid, dept: dept || 'General' };

    broadcastAdmin('admin:feed', {
      msg: `✅ New ${role} registered: ${fullName} (${sid})`,
      type: 'safe', time: new Date().toLocaleTimeString()
    });

    console.log(`[Auth] Registered: ${fullName} (${role})`);
    res.status(201).json({ ok: true, user: newUser });

  } catch (err) {
    console.error('[Auth] Register error:', err);
    res.status(500).json({ error: 'Database error during registration' });
  }
});

// ═══════════════════════════════════════════════════════
//  REST — USERS
// ═══════════════════════════════════════════════════════
app.get('/api/users', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, email, role, name, sid, dept, last_login, registered_at FROM users ORDER BY registered_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ═══════════════════════════════════════════════════════
//  REST — EXAMS
// ═══════════════════════════════════════════════════════
app.get('/api/exams', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM exams ORDER BY created_at DESC');
    // Map DB column names to what frontend expects
    const exams = rows.map(e => ({
      id:       e.id,
      title:    e.title,
      code:     e.code,
      subject:  e.subject,
      dur:      e.duration,
      marks:    e.total_marks,
      pass:     e.pass_marks,
      active:   e.is_active === 1,
      desc:     e.description,
      students: 0,
    }));
    res.json(exams);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch exams' });
  }
});

app.post('/api/exams', async (req, res) => {
  const { title, code, subject, dur, marks, pass, desc } = req.body;
  if (!title || !code)
    return res.status(400).json({ error: 'title and code are required' });

  try {
    const [dup] = await pool.query('SELECT id FROM exams WHERE code = ?', [code]);
    if (dup.length > 0)
      return res.status(409).json({ error: 'Duplicate exam code' });

    const newId = uuid();
    await pool.query(
      `INSERT INTO exams (id, title, code, subject, duration, total_marks, pass_marks, is_active, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [newId, title, code, subject || 'General', dur || 60, marks || 100, pass || 40, desc || '']
    );

    broadcastAdmin('admin:feed', { msg: `📝 Exam created: "${title}"`, type: 'safe', time: new Date().toLocaleTimeString() });
    res.status(201).json({ id: newId, title, code, subject, dur, marks, pass, active: true, students: 0, desc });

  } catch (err) {
    console.error('[Exams] Create error:', err);
    res.status(500).json({ error: 'Failed to create exam' });
  }
});

app.put('/api/exams/:id', async (req, res) => {
  const { title, code, subject, dur, marks, pass, desc, active } = req.body;
  try {
    await pool.query(
      `UPDATE exams SET title=?, code=?, subject=?, duration=?, total_marks=?,
       pass_marks=?, is_active=?, description=? WHERE id=?`,
      [title, code, subject, dur, marks, pass, active ? 1 : 0, desc, req.params.id]
    );
    broadcastAdmin('admin:feed', { msg: `✏ Exam updated: "${title}"`, type: 'safe', time: new Date().toLocaleTimeString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update exam' });
  }
});

app.delete('/api/exams/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT title FROM exams WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Exam not found' });

    await pool.query('DELETE FROM exams WHERE id = ?', [req.params.id]);
    broadcastAdmin('admin:feed', { msg: `🗑 Exam deleted: "${rows[0].title}"`, type: 'danger', time: new Date().toLocaleTimeString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete exam' });
  }
});

// ═══════════════════════════════════════════════════════
//  REST — STUDENTS (live sessions)
// ═══════════════════════════════════════════════════════
app.get('/api/students', async (req, res) => {
  try {
    // Return live in-memory sessions merged with DB student list
    const [dbStudents] = await pool.query(
      'SELECT id, name, sid, dept, email FROM users WHERE role = ? ORDER BY registered_at DESC',
      ['student']
    );
    // Merge live session data
    const merged = dbStudents.map(s => {
      const live = liveSessions[s.sid];
      return live ? { ...s, ...live } : s;
    });
    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

app.post('/api/students', async (req, res) => {
  const { firstName, lastName, email, sid, dept, password } = req.body;
  if (!firstName || !lastName || !email || !sid || !password)
    return res.status(400).json({ error: 'All fields required' });

  try {
    const em = email.trim().toLowerCase();
    const [dup] = await pool.query('SELECT id FROM users WHERE email = ? OR sid = ?', [em, sid]);
    if (dup.length > 0)
      return res.status(409).json({ error: 'Email or Student ID already registered' });

    const newId = uuid();
    const fullName = `${firstName} ${lastName}`;
    await pool.query(
      'INSERT INTO users (id, email, password, role, name, sid, dept) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newId, em, password, 'student', fullName, sid, dept || 'General']
    );

    broadcastAdmin('admin:feed', { msg: `✓ Student added: ${fullName}`, type: 'safe', time: new Date().toLocaleTimeString() });
    res.status(201).json({ ok: true, user: { id: newId, name: fullName, sid, dept, email: em } });

  } catch (err) {
    console.error('[Students] Add error:', err);
    res.status(500).json({ error: 'Failed to add student' });
  }
});

// ═══════════════════════════════════════════════════════
//  REST — EXAM REPORTS
// ═══════════════════════════════════════════════════════
app.get('/api/reports', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM exam_reports ORDER BY submitted_at DESC');
    const reports = rows.map(r => ({
      ...r,
      violations: r.violations_json ? JSON.parse(r.violations_json) : [],
      pdfHtml:    r.pdf_html,
      reportId:   r.id,
      intScore:   r.int_score,
      riskScore:  r.risk_score,
      riskLevel:  r.risk_level,
      pct:        r.percentage,
      autoSubmit: r.auto_submit === 1,
      timeSubmitted: r.submitted_at,
      receivedAt: r.received_at,
    }));
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

app.post('/api/reports', async (req, res) => {
  const r = req.body;
  const reportId  = 'RPT-' + Date.now();
  const riskScore = 100 - (r.intScore || 100);
  const riskLevel = riskScore >= 60 ? 'HIGH RISK' : riskScore >= 30 ? 'MEDIUM RISK' : 'LOW RISK';

  try {
    await pool.query(
      `INSERT INTO exam_reports
         (id, student_name, student_sid, subject, score, total, percentage,
          int_score, risk_score, risk_level, auto_submit, received_at, violations_json, pdf_html)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURTIME(), ?, ?)`,
      [
        reportId,
        r.name || 'Unknown',
        r.id   || r.sid || 'UNKNOWN',
        r.subject || 'General',
        r.score || 0,
        r.total || 10,
        r.pct   || 0,
        r.intScore  || 100,
        riskScore,
        riskLevel,
        r.autoSubmit ? 1 : 0,
        JSON.stringify(r.violations || []),
        r.pdfHtml || null,
      ]
    );

    // Also save each violation row individually
    if (r.violations && r.violations.length > 0) {
      const [session] = await pool.query(
        'SELECT id FROM exam_sessions WHERE student_sid = ? ORDER BY joined_at DESC LIMIT 1',
        [r.id || r.sid || 'UNKNOWN']
      );
      if (session.length > 0) {
        const sessionId = session[0].id;
        for (const v of r.violations) {
          await pool.query(
            'INSERT INTO violations (session_id, student_sid, text, severity, icon, deducted) VALUES (?, ?, ?, ?, ?, ?)',
            [sessionId, r.id || r.sid, v.text, v.sev || 'med', v.icon || '⚠️', v.deduct || 0]
          ).catch(() => {}); // non-fatal
        }
      }
    }

    // Update live session status
    if (liveSessions[r.id || r.sid]) {
      liveSessions[r.id || r.sid].status = 'submitted';
      broadcastAdmin('admin:student-update', liveSessions[r.id || r.sid]);
    }

    const report = {
      ...r, reportId, riskScore, riskLevel,
      receivedAt: new Date().toLocaleTimeString(),
    };

    broadcastAdmin('admin:report', report);
    broadcastAdmin('admin:feed', {
      msg:  `📨 Report: ${r.name} — ${riskLevel} (${riskScore}/100)`,
      type: 'info', time: new Date().toLocaleTimeString()
    });

    res.status(201).json({ ok: true, reportId });

  } catch (err) {
    console.error('[Reports] Save error:', err);
    res.status(500).json({ error: 'Failed to save report' });
  }
});

// ═══════════════════════════════════════════════════════
//  REST — MESSAGES
// ═══════════════════════════════════════════════════════
app.get('/api/messages/:sid', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT from_role AS `from`, text, sent_at AS time FROM messages WHERE student_sid = ? ORDER BY sent_at ASC',
      [req.params.sid]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.post('/api/messages/:sid', async (req, res) => {
  const { text } = req.body;
  const { sid }  = req.params;
  if (!text) return res.status(400).json({ error: 'text required' });

  try {
    await pool.query(
      'INSERT INTO messages (student_sid, from_role, text) VALUES (?, ?, ?)',
      [sid, 'admin', text]
    );

    const msg = { from: 'admin', text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };

    const session = liveSessions[sid];
    if (session && session.socketId) {
      io.to(session.socketId).emit('student:message', msg);
    }

    broadcastAdmin('admin:feed', {
      msg:  `✉ Message → ${session?.name || sid}`,
      type: 'safe', time: new Date().toLocaleTimeString()
    });

    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Catch-all SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ═══════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════
io.on('connection', socket => {
  console.log(`[Socket] connected: ${socket.id}`);

  socket.on('admin:join', async ({ adminName }) => {
    socket.join('admins');
    console.log(`[Socket] Admin: ${adminName}`);

    // Send snapshot of live sessions + recent reports from DB
    try {
      const [reports] = await pool.query(
        'SELECT * FROM exam_reports ORDER BY submitted_at DESC LIMIT 20'
      );
      const mapped = reports.map(r => ({
        ...r,
        violations: r.violations_json ? JSON.parse(r.violations_json) : [],
        pdfHtml: r.pdf_html, reportId: r.id,
        intScore: r.int_score, riskScore: r.risk_score,
        riskLevel: r.risk_level, pct: r.percentage,
        timeSubmitted: r.submitted_at, receivedAt: r.received_at,
      }));
      socket.emit('admin:snapshot', {
        students: Object.values(liveSessions),
        reports:  mapped,
      });
    } catch (e) {
      socket.emit('admin:snapshot', { students: Object.values(liveSessions), reports: [] });
    }
  });

  socket.on('student:join', async ({ sid, name, dept, examCode }) => {
    const session = {
      id: sid, name, dept,
      intScore:  100,
      riskScore: 0,
      violations: [],
      status:    'active',
      socketId:  socket.id,
      examCode,
      joinedAt:  new Date().toLocaleTimeString(),
    };
    liveSessions[sid] = session;
    socket.join(`student:${sid}`);

    // Persist session start to DB
    try {
      await pool.query(
        `INSERT INTO exam_sessions (student_sid, student_name, dept, exam_code, socket_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status='active', socket_id=?, joined_at=NOW()`,
        [sid, name, dept || 'General', examCode || null, socket.id, socket.id]
      );
    } catch (e) { /* non-fatal */ }

    broadcastAdmin('admin:student-join', session);
    broadcastAdmin('admin:feed', {
      msg:  `🎓 Student joined: ${name} (${sid})`,
      type: 'info', time: new Date().toLocaleTimeString()
    });
    console.log(`[Socket] Student joined: ${name} (${sid})`);
  });

  socket.on('student:violation', async ({ sid, violation }) => {
    const session = liveSessions[sid];
    if (!session) return;

    session.violations.push(violation);
    session.intScore  = Math.max(0, session.intScore - (violation.deduct || 5));
    session.riskScore = 100 - session.intScore;

    if (session.violations.length >= 5 && session.status === 'active')
      session.status = 'suspicious';
    if (session.violations.filter(v => v.sev === 'crit').length >= 2)
      session.status = 'flagged';

    // Persist violation to DB
    try {
      const [s] = await pool.query(
        'SELECT id FROM exam_sessions WHERE student_sid = ? ORDER BY joined_at DESC LIMIT 1',
        [sid]
      );
      if (s.length > 0) {
        await pool.query(
          'INSERT INTO violations (session_id, student_sid, text, severity, icon, deducted) VALUES (?, ?, ?, ?, ?, ?)',
          [s[0].id, sid, violation.text, violation.sev || 'med', violation.icon || '⚠️', violation.deduct || 0]
        );
        // Update int_score in session table
        await pool.query(
          'UPDATE exam_sessions SET int_score=?, risk_score=?, status=? WHERE id=?',
          [session.intScore, session.riskScore, session.status, s[0].id]
        );
      }
    } catch (e) { /* non-fatal */ }

    broadcastAdmin('admin:student-update', session);
    broadcastAdmin('admin:violation', { sid, violation, intScore: session.intScore });
    broadcastAdmin('admin:feed', {
      msg:  `⚠ ${violation.icon||'⚠'} ${session.name}: ${violation.text}`,
      type: violation.sev === 'crit' ? 'danger' : 'warn',
      time: new Date().toLocaleTimeString()
    });
  });

  socket.on('student:heartbeat', async ({ sid, intScore }) => {
    const session = liveSessions[sid];
    if (!session) return;
    session.intScore  = intScore;
    session.riskScore = 100 - intScore;
    try {
      await pool.query(
        'UPDATE exam_sessions SET int_score=?, risk_score=? WHERE student_sid=? AND status != "submitted"',
        [intScore, 100 - intScore, sid]
      );
    } catch (e) {}
    broadcastAdmin('admin:student-update', { id: sid, intScore, riskScore: 100 - intScore });
  });

  socket.on('student:ai-state', ({ sid, aiState }) => {
    const session = liveSessions[sid];
    if (!session) return;
    session.aiState = aiState;
    broadcastAdmin('admin:ai-state', { id: sid, aiState });
  });

  socket.on('admin:action', ({ action, sid }) => {
    const session = liveSessions[sid];
    if (!session) return;
    if (action === 'warn') {
      io.to(`student:${sid}`).emit('student:warning', { text: 'Formal warning issued by proctor. Continue ethically.' });
      broadcastAdmin('admin:feed', { msg:`⚠ Warning → ${session.name}`, type:'warn', time: new Date().toLocaleTimeString() });
    } else if (action === 'terminate') {
      session.status = 'flagged';
      io.to(`student:${sid}`).emit('student:terminate', { reason: 'Session terminated by proctor due to integrity violations.' });
      broadcastAdmin('admin:student-update', session);
      broadcastAdmin('admin:feed', { msg:`🚫 Terminated: ${session.name}`, type:'danger', time: new Date().toLocaleTimeString() });
    } else if (action === 'clear') {
      session.status = 'active';
      broadcastAdmin('admin:student-update', session);
      broadcastAdmin('admin:feed', { msg:`✓ Flag cleared: ${session.name}`, type:'safe', time: new Date().toLocaleTimeString() });
    }
  });

  // ── WebRTC Signaling ──
  socket.on('webrtc:ready',         ({ sid }) => { broadcastAdmin('webrtc:student-ready', { sid }); });
  socket.on('webrtc:request-offer', ({ sid }) => {
    const session = liveSessions[sid];
    if (session?.socketId) io.to(session.socketId).emit('webrtc:request-offer', { adminSocketId: socket.id });
  });
  socket.on('webrtc:offer',  ({ adminSocketId, sid, sdp }) => { io.to(adminSocketId).emit('webrtc:offer', { sid, sdp }); });
  socket.on('webrtc:answer', ({ sid, sdp }) => {
    const session = liveSessions[sid];
    if (session?.socketId) io.to(session.socketId).emit('webrtc:answer', { adminSocketId: socket.id, sdp });
  });
  socket.on('webrtc:ice-candidate', ({ target, sid, candidate }) => {
    if (target === 'admin') { broadcastAdmin('webrtc:ice-candidate', { sid, candidate }); }
    else {
      const session = liveSessions[sid];
      if (session?.socketId) io.to(session.socketId).emit('webrtc:ice-candidate', { adminSocketId: socket.id, candidate });
    }
  });
  socket.on('webrtc:stop', ({ sid }) => { broadcastAdmin('webrtc:stop', { sid }); });

  socket.on('disconnect', async () => {
    const session = Object.values(liveSessions).find(s => s.socketId === socket.id);
    if (session && session.status !== 'submitted') {
      session.status = 'disconnected';
      try {
        await pool.query(
          'UPDATE exam_sessions SET status="disconnected" WHERE student_sid=? AND socket_id=?',
          [session.id, socket.id]
        );
      } catch (e) {}
      broadcastAdmin('admin:student-update', session);
      broadcastAdmin('admin:feed', { msg:`⚡ ${session.name} disconnected`, type:'warn', time: new Date().toLocaleTimeString() });
    }
    console.log(`[Socket] disconnected: ${socket.id}`);
  });
});

// ═══════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🟢  ProctorAI backend  →  http://localhost:${PORT}`);
  console.log(`    Database         →  MySQL: proctorai_db`);
  console.log(`    REST API         →  http://localhost:${PORT}/api\n`);
});
