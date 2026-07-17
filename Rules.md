# Rules.md — Coding Conventions & Guardrails

> These rules are mandatory. Before writing any code, re-check this file. If a request conflicts with these rules, follow the rules and flag the conflict instead of silently deviating.

## 1. General Principles
- Always read `PRD.md`, `Architecture.md`, and `Phases.md` before implementing a new feature.
- Only build what the current active phase (see `Phases.md`) requires. Do not jump ahead to future phases unless explicitly asked.
- Prefer editing/extending existing files over creating new duplicate ones.
- After completing a task, append an entry to `Memory.md` (see its template) — do not skip this.

## 2. Naming Conventions
- **Files (backend)**: `camelCase` for utils/services, `PascalCase` for models (e.g. `Contact.js`), `<name>.controller.js` / `<name>.routes.js` pattern.
- **Files (frontend)**: React components in `PascalCase.jsx`, hooks as `useSomething.js`, stores as `xStore.js`.
- **Variables/functions**: `camelCase`. Booleans prefixed `is`/`has` (e.g. `isLoading`).
- **MongoDB fields**: `camelCase`, not `snake_case`.
- **API routes**: plural, kebab-case where multi-word (e.g. `/api/contacts`, `/api/whatsapp-templates`).
- **Constants/enums**: `UPPER_SNAKE_CASE` only for true constants (e.g. `MAX_RETRIES`); status enums stay lowercase strings (`"lead"`, `"won"`) to match the schema.

## 3. Code Style
- Use ES modules (`import`/`export`), not `require`, unless the existing file already uses CommonJS — stay consistent within a file.
- Async/await only — no raw `.then()` chains.
- Every async route handler wrapped in try/catch, errors passed to centralized `error.middleware.js`.
- No inline magic numbers/strings for enums — reference shared constants.
- Functional React components only. No class components.
- Keep components under ~200 lines; extract sub-components when they grow beyond that.
- Tailwind for all styling — no inline `style={{}}` unless dynamic values require it, no separate CSS files per component.

## 4. API Response Format (must be consistent everywhere)
```json
// success
{ "success": true, "data": {}, "message": "" }

// error
{ "success": false, "message": "Human-readable error", "error": "optional detail" }
```
Use the `utils/apiResponse.js` helper for every response — don't hand-roll `res.json()` differently in each controller.

## 5. Security Do's and Don'ts
- ✅ All secrets in `.env`, never hardcoded.
- ✅ Validate/sanitize all incoming request bodies (use `express-validator` or `zod`).
- ✅ Every non-auth route protected by `auth.middleware.js`.
- ❌ Never log the full WhatsApp token or JWT secret to console.
- ❌ Never commit `.env` — must be in `.gitignore`.
- ❌ Never expose internal Mongo `_id` structure changes without checking references across models.

## 6. Things NOT to Touch Without Explicit Instruction
- Do not change the database schema field names defined in `Architecture.md` once Phase 2 is complete (breaks existing data).
- Do not change the WhatsApp webhook route path or verify-token logic without updating it in Meta's dashboard too — always flag this to the user.
- Do not add new npm dependencies for something achievable with the existing stack — ask first if unsure.
- Do not modify `Rules.md`, `PRD.md`, `Architecture.md` — these are user-owned planning docs, not code.

## 7. Git Commit Convention
```
feat: add contact CRUD endpoints
fix: correct webhook verify token check
refactor: extract whatsapp service layer
chore: update dependencies
```

## 8. Comments
- Comment *why*, not *what* (code should be self-explanatory for the "what").
- Add a short JSDoc block above non-trivial service functions (e.g. `whatsapp.service.js` functions).

## 9. When Uncertain
If a requirement is ambiguous or a decision has multiple valid approaches, **state the assumption made and proceed** — don't block progress, but log the assumption in `Memory.md` so it can be revisited.
