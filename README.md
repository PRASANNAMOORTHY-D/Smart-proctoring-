# ProctorAI — Smart Exam Integrity System

A full-stack AI-powered online exam proctoring system with real-time
multi-student monitoring, face detection, violation tracking, and PDF reports.

## Project Structure

```
proctorai/
├── backend/
│   ├── server.js       ← Express REST API + Socket.io
│   └── package.json    ← Node.js dependencies
└── frontend/
    ├── index.html      ← HTML (no inline CSS or JS)
    ├── style.css       ← All styles (dark military design system)
    └── app.js          ← All client logic + Socket.io + REST API layer
```

## Quick Start

### 1. Install & start the backend

```bash
cd backend
npm install
npm start
# Server starts on http://localhost:3000
```

### 2. Open the frontend

Just visit `http://localhost:3000` — the backend serves the frontend automatically.

> **Offline / file:// mode** — Open `frontend/index.html` directly in a browser.
> The app detects no server and falls back to localStorage for all data.
> Everything works except real-time multi-student sync.

## Demo Credentials

| Role    | Email                    | Password     |
|---------|--------------------------|--------------|
| Student | priya@student.edu        | Student@123  |
| Student | arjun@student.edu        | Student@123  |
| Student | kavya@student.edu        | Student@123  |
| Admin   | admin@proctorai.edu      | Admin@123    |

Admin registration code: `ADMIN2025`

## REST API

| Method | Endpoint                | Description                |
|--------|-------------------------|----------------------------|
| POST   | /api/auth/login         | Login                      |
| POST   | /api/auth/register      | Register                   |
| GET    | /api/users              | List users                 |
| GET    | /api/exams              | List exams                 |
| POST   | /api/exams              | Create exam                |
| PUT    | /api/exams/:id          | Update exam                |
| DELETE | /api/exams/:id          | Delete exam                |
| GET    | /api/students           | Live session list          |
| POST   | /api/students           | Add student manually       |
| POST   | /api/reports            | Submit exam report         |
| GET    | /api/reports            | List all reports           |
| GET    | /api/messages/:sid      | Get conversation           |
| POST   | /api/messages/:sid      | Send message to student    |

## Socket.io Events

### Server → Client
| Event                  | Description                          |
|------------------------|--------------------------------------|
| `admin:feed`           | Live alert feed entry                |
| `admin:snapshot`       | Initial state on admin login         |
| `admin:student-join`   | Student joined exam                  |
| `admin:student-update` | Student integrity/status changed     |
| `admin:report`         | New exam report received             |
| `student:message`      | Admin sent a message                 |
| `student:warning`      | Admin issued a warning               |
| `student:terminate`    | Admin terminated session             |

### Client → Server
| Event                 | Description                           |
|-----------------------|---------------------------------------|
| `admin:join`          | Admin connects to room                |
| `admin:action`        | warn / terminate / clear a student    |
| `student:join`        | Student starts exam                   |
| `student:violation`   | Violation detected                    |
| `student:heartbeat`   | Periodic integrity score update       |

## Features Fixed vs Original

| Issue                          | Fix                                              |
|--------------------------------|--------------------------------------------------|
| No localStorage                | Full LS persistence layer — data survives refresh|
| All admin cards share stream   | `new MediaStream([track])` per card             |
| No live risk score             | `#ex-risk` element + `deductInt()` drives it    |
| PDF download was HTML blob     | Real jsPDF with `autoTable`                     |
| Truncated `closeAlert()`       | Completed + closing tags added                  |
| No backend                     | Express + Socket.io with REST API               |
| Single-tab only                | Socket.io enables real-time multi-student sync  |

## Tech Stack

- **Frontend**: Vanilla JS, face-api.js, Chart.js, jsPDF, Socket.io client
- **Backend**: Node.js, Express, Socket.io, CORS, UUID
- **AI Models**: face-api.js (TinyFaceDetector + 68-landmark + expressions)
