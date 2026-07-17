# Architecture.md — Technical Architecture

## 1. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React (Vite) + TailwindCSS + Zustand (state) + React Router |
| Backend | Node.js + Express |
| Database | MongoDB (Mongoose ODM) |
| Real-time | Socket.io |
| Auth | JWT (access + refresh token) |
| WhatsApp | Meta WhatsApp Cloud API (Graph API v20.0) |
| File storage | Cloudinary (free tier) — for media messages |
| Hosting (backend) | Render / Railway |
| Hosting (frontend) | Vercel |
| DB hosting | MongoDB Atlas (free tier) |

## 2. Folder Structure

```
wacrm/
├── backend/
│   ├── src/
│   │   ├── config/
│   │   │   ├── db.js
│   │   │   └── env.js
│   │   ├── models/
│   │   │   ├── User.js
│   │   │   ├── Contact.js
│   │   │   ├── Message.js
│   │   │   ├── Deal.js
│   │   │   └── Template.js
│   │   ├── controllers/
│   │   │   ├── auth.controller.js
│   │   │   ├── contact.controller.js
│   │   │   ├── message.controller.js
│   │   │   ├── deal.controller.js
│   │   │   └── whatsapp.controller.js
│   │   ├── routes/
│   │   │   ├── auth.routes.js
│   │   │   ├── contact.routes.js
│   │   │   ├── message.routes.js
│   │   │   ├── deal.routes.js
│   │   │   └── whatsapp.routes.js
│   │   ├── middleware/
│   │   │   ├── auth.middleware.js
│   │   │   ├── role.middleware.js
│   │   │   └── error.middleware.js
│   │   ├── services/
│   │   │   ├── whatsapp.service.js   (all Graph API calls live here)
│   │   │   └── socket.service.js
│   │   ├── utils/
│   │   │   └── apiResponse.js
│   │   ├── app.js
│   │   └── server.js
│   ├── .env
│   └── package.json
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── ui/            (Button, Input, Card, Badge — reusable primitives)
│   │   │   ├── chat/          (ChatWindow, MessageBubble, ChatList)
│   │   │   ├── contacts/      (ContactList, ContactCard, ContactDrawer)
│   │   │   └── pipeline/      (KanbanBoard, StageColumn, DealCard)
│   │   ├── pages/
│   │   │   ├── Login.jsx
│   │   │   ├── Dashboard.jsx
│   │   │   ├── Inbox.jsx
│   │   │   ├── Pipeline.jsx
│   │   │   └── Settings.jsx
│   │   ├── store/             (Zustand stores: authStore, chatStore, contactStore)
│   │   ├── services/          (axios instance, api.js)
│   │   ├── hooks/
│   │   ├── App.jsx
│   │   └── main.jsx
│   └── package.json
│
├── PRD.md
├── Architecture.md
├── Rules.md
├── Phases.md
├── Design.md
└── Memory.md
```

## 3. High-Level Data Flow

```
Customer's WhatsApp
      │  (sends message)
      ▼
Meta WhatsApp Cloud API
      │  (webhook POST)
      ▼
backend/whatsapp.routes.js  →  whatsapp.controller.js
      │
      ├─→ Save to MongoDB (Message + auto-create/link Contact)
      │
      └─→ socket.service.js  →  emit "new_message" event
                                     │
                                     ▼
                          Frontend (Inbox.jsx) updates in real time

Agent replies in CRM UI
      │
      ▼
frontend → POST /api/messages/send
      │
      ▼
backend → whatsapp.service.js → Meta Graph API → delivered to customer
```

## 4. Database Schema (MongoDB / Mongoose)

### User
```js
{
  name: String,
  email: { type: String, unique: true },
  password: String, // hashed
  role: { type: String, enum: ["admin", "agent"], default: "agent" },
  createdAt: Date
}
```

### Contact
```js
{
  name: String,
  phone: { type: String, unique: true },   // WhatsApp number, E.164 format
  email: String,
  tags: [String],
  status: { type: String, enum: ["lead","customer","closed","lost"], default: "lead" },
  assignedTo: { type: ObjectId, ref: "User" },
  source: String,
  lastMessageAt: Date,
  createdAt: Date
}
```

### Message
```js
{
  contact: { type: ObjectId, ref: "Contact" },
  sender: { type: ObjectId, ref: "User" }, // null if from customer
  direction: { type: String, enum: ["incoming","outgoing"] },
  type: { type: String, enum: ["text","template","image","document"], default: "text" },
  body: String,
  status: { type: String, enum: ["sent","delivered","read","failed"], default: "sent" },
  whatsappMessageId: String,
  timestamp: Date
}
```

### Deal (Pipeline card)
```js
{
  contact: { type: ObjectId, ref: "Contact" },
  stage: { type: String, enum: ["new","contacted","qualified","won","lost"], default: "new" },
  value: Number,
  assignedTo: { type: ObjectId, ref: "User" },
  createdAt: Date
}
```

### Template
```js
{
  name: String,           // must match Meta-approved template name
  language: String,
  bodyPreview: String,
  variables: [String]
}
```

## 5. API Endpoints (v1)

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/auth/register | Create user (admin only, invite flow) |
| POST | /api/auth/login | Login, returns JWT |
| GET | /api/contacts | List contacts (filter/search) |
| POST | /api/contacts | Create contact |
| GET | /api/contacts/:id | Contact detail + message history |
| PATCH | /api/contacts/:id | Update contact/status |
| GET | /api/messages/:contactId | Get message thread |
| POST | /api/messages/send | Send message (text or template) |
| POST | /api/whatsapp/webhook | Meta webhook (GET verify / POST receive) |
| GET | /api/deals | List pipeline deals |
| PATCH | /api/deals/:id | Move stage / update deal |
| GET | /api/templates | List approved templates |

## 6. Auth Flow
- JWT access token (15 min expiry) + refresh token (7 days, httpOnly cookie).
- `auth.middleware.js` verifies access token on protected routes.
- `role.middleware.js` restricts admin-only routes (e.g., team management, analytics).

## 7. Real-time Layer
- Socket.io server attached to the same Express server.
- Rooms per user (`socket.join(userId)`) so agents only receive events for contacts assigned to them; admins join a global room.
- Events: `new_message`, `message_status_update`, `deal_updated`.

## 8. Environment Variables (backend/.env)
```
PORT=5000
MONGO_URI=
JWT_SECRET=
JWT_REFRESH_SECRET=
WHATSAPP_TOKEN=
WHATSAPP_PHONE_ID=
WHATSAPP_VERIFY_TOKEN=
CLOUDINARY_URL=
CLIENT_URL=
```
