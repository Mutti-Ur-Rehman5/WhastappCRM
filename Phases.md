# Phases.md — Build Roadmap

> Build strictly in order. Do not start a phase until the previous one's acceptance criteria are met. Mark phases as done in `Memory.md` when complete.

---

## Phase 0 — Project Setup
**Goal:** Empty but running skeleton, both ends connected.
- Initialize backend (Express) and frontend (Vite + React + Tailwind).
- Connect MongoDB Atlas.
- Set up `.env` files, folder structure per `Architecture.md`.
- Basic health-check route `GET /api/health`.
- Frontend calls health-check and displays "Connected" — proves the stack works end to end.

**Acceptance:** `npm run dev` on both ends works, frontend shows backend is reachable.

---

## Phase 1 — Authentication & Team
- User model, register/login/JWT routes.
- Password hashing (bcrypt).
- `auth.middleware.js` + `role.middleware.js`.
- Frontend: Login page, protected route wrapper, auth store (Zustand).
- Admin can invite an Agent (simple email-based invite, no email sending needed yet — generate a signup link).

**Acceptance:** Can register admin, log in, log out; agent role restricted from admin-only routes.

---

## Phase 2 — Contact / Lead Management
- Contact model + CRUD API.
- Frontend: Contacts list page (table/cards), search & filter by status/tag, contact detail drawer.
- Manual "Add Contact" form.
- CSV import (basic — name, phone, email columns).

**Acceptance:** Can create, view, edit, filter, and delete contacts from the UI.

---

## Phase 3 — WhatsApp Integration (Core)
- Meta Developer app set up (done outside code — see the WhatsApp setup guide).
- `whatsapp.service.js`: send text message, send template message.
- Webhook route: GET verify + POST receive incoming messages.
- Incoming message → auto-create Contact if number unknown, save Message.
- Basic test: send a message from Postman/UI, receive a reply, confirm it lands in MongoDB.

**Acceptance:** A real WhatsApp message sent to the test number is stored as a Message linked to a Contact; a reply sent from the backend is received on a real phone.

---

## Phase 4 — Inbox / Chat UI
- Frontend: Inbox page — conversation list (left) + chat window (right), like a standard CRM inbox.
- Message bubbles (incoming left, outgoing right), timestamps, status ticks.
- Send box with text input; disable free-text and show "template only" state if outside 24hr window.
- Socket.io wired: new incoming message appears without refresh.

**Acceptance:** Two-way conversation visible and usable entirely from the CRM UI, updating in real time.

---

## Phase 5 — Pipeline / Deals (Kanban)
- Deal model + CRUD API.
- Frontend: Kanban board, drag-and-drop between stages (use `@dnd-kit` or `react-beautiful-dnd`).
- Creating a deal from a Contact record.

**Acceptance:** Can drag a contact/deal card across stages and it persists on reload.

---

## Phase 6 — Templates Management
- Fetch approved templates from Meta (or manually mirror them in the Template model for now).
- Frontend: Template picker inside the chat composer, with variable fill-in fields.

**Acceptance:** Agent can pick a template, fill variables, and send it successfully outside the 24hr window.

---

## Phase 7 — Dashboard & Analytics
- Aggregate queries: total leads, conversion rate, avg response time, messages/week.
- Frontend: Dashboard page with charts (use `recharts`).
- Admin-only: per-agent performance breakdown.

**Acceptance:** Dashboard reflects real data accurately and updates as new contacts/messages come in.

---

## Phase 8 — Notifications
- Real-time in-app toast/badge on new incoming message (Socket.io event already exists from Phase 4 — wire up the UI notification).
- Unread count per conversation.

**Acceptance:** Agent sees a live notification without needing to be on the Inbox page.

---

## Phase 9 — Polish & Testing
- Responsive design pass (mobile/tablet).
- Error states, empty states, loading skeletons across all pages.
- Basic input validation everywhere (frontend + backend).
- Manual QA pass against every user story in `PRD.md`.

**Acceptance:** No broken states; every PRD user story is demonstrably working.

---

## Phase 10 — Deployment
- Backend → Render/Railway, env vars set.
- Frontend → Vercel.
- MongoDB Atlas production cluster.
- Update Meta webhook URL to production HTTPS URL.
- Smoke test the full flow in production.

**Acceptance:** Live app, real WhatsApp number connected, working end to end in production.

---

## Future / v1.1 (Not in current scope — do not build yet)
- Media messages (images/documents).
- Bulk broadcast campaigns.
- Automation/chatbot rules.
- Multi-channel (Instagram/Email).
