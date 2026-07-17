# PRD.md — Product Requirements Document

## 1. Product Name
**WaCRM** — A lightweight WhatsApp-integrated CRM for small & medium businesses.

## 2. Problem Statement
Small businesses manage leads and customer conversations across scattered WhatsApp chats, spreadsheets, and memory. There's no single place to track a lead's status, message history, and follow-ups. WaCRM centralizes WhatsApp conversations with a proper CRM pipeline.

## 3. Target Users
- Small business owners / sales teams (1–20 people) who use WhatsApp as their primary sales channel.
- Freelancers/agencies managing multiple client leads via WhatsApp.

## 4. Goals
- Let a team manage all WhatsApp leads/customers from one dashboard.
- Track every conversation against a Contact record automatically.
- Move leads through a sales pipeline (Kanban-style).
- Send template messages / bulk follow-ups without leaving the app.
- Give the owner visibility into team activity and conversion metrics.

## 5. Non-Goals (Out of Scope for v1)
- Building a WhatsApp clone/UI replica — this is a CRM with WhatsApp as a channel, not a messaging app.
- Multi-channel support (Instagram, Email) — WhatsApp only in v1.
- Payment processing — not included in this version.
- Voice/video calls.

## 6. Core Features

### 6.1 Authentication & Team
- Email/password login (JWT).
- Roles: **Admin** (full access), **Agent** (assigned contacts only).
- Invite team members via email.

### 6.2 Contact / Lead Management
- Auto-create a Contact when a new WhatsApp number messages in.
- Manual contact creation/import (CSV).
- Fields: name, phone, email, tags, source, assigned agent, status (Lead / Customer / Closed / Lost).
- Notes & activity timeline per contact.

### 6.3 WhatsApp Messaging
- Two-way messaging via WhatsApp Cloud API.
- Real-time incoming message updates (Socket.io).
- Send text messages (within 24hr window) and approved template messages (outside window).
- Message status indicators: sent / delivered / read / failed.
- Media support (images, documents) — v1.1 stretch goal.

### 6.4 Pipeline / Deals (Kanban)
- Configurable pipeline stages (e.g., New → Contacted → Qualified → Won → Lost).
- Drag-and-drop contact cards between stages.

### 6.5 Templates
- View/manage WhatsApp-approved message templates.
- Insert template with variable fields when composing.

### 6.6 Dashboard & Analytics
- Total leads, conversion rate, response time, messages sent/received (weekly view).
- Per-agent performance (Admin only).

### 6.7 Notifications
- In-app real-time notification on new incoming message.
- (Optional v1.1) Browser push notification.

## 7. User Stories
- *As an Agent*, I want to see all my assigned contacts and reply to their WhatsApp messages inside the CRM, so I don't need to switch apps.
- *As an Admin*, I want to see which leads haven't been contacted in 24 hours, so nothing falls through.
- *As an Admin*, I want to move a contact through pipeline stages and see conversion metrics.
- *As an Agent*, I want to send a pre-approved template message to a lead that hasn't replied in over 24 hours.

## 8. Success Metrics
- Time to first response to a new lead < 1 hour.
- 100% of WhatsApp conversations logged against a Contact (no missed messages).
- Pipeline conversion rate visible and trending upward month-over-month.

## 9. Assumptions
- Business already has (or will register) a WhatsApp Business phone number via Meta.
- Team size is small enough that a Kanban pipeline (not complex automation) is sufficient for v1.
