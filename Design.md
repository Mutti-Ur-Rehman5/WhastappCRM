# Design.md — UI/UX Guidelines

> Goal: this should look like a real, funded SaaS product (think Linear, Attio, HubSpot's cleaner screens) — **not** a default AI-generated template. Avoid the "obviously AI-built" tells listed in section 6 below.

## 1. Design Philosophy
- Clean, dense-but-breathable CRM layout: sidebar navigation + content area, not a marketing-landing-page style dashboard.
- Function first: every screen should feel like a tool a busy salesperson uses 8 hours a day — fast, low-friction, not decorative.
- Subtle, confident, not flashy. No unnecessary animation, no gradient backgrounds behind actual work screens.

## 2. Color Palette
Use a **restrained** palette — one primary, one neutral scale, a few semantic colors. Do not use purple-to-blue gradients everywhere (the #1 "AI app" tell).

```
Primary:      #16A34A  (WhatsApp-adjacent green, but slightly muted — not neon)
Primary Dark: #15803D
Neutral-950:  #0A0A0B   (text, dark mode bg)
Neutral-800:  #1F2023
Neutral-500:  #6B7280   (secondary text)
Neutral-200:  #E5E7EB   (borders)
Neutral-50:   #FAFAFA   (page background)
White:        #FFFFFF   (cards)

Semantic:
Success:  #16A34A
Warning:  #D97706
Danger:   #DC2626
Info:     #2563EB
```
- Backgrounds: use `Neutral-50` for the app shell, `White` for cards — not pure gradients or glassmorphism.
- Use color sparingly for status badges (lead=blue, customer=green, lost=red-ish neutral, closed=neutral).

## 3. Typography
- Font: **Inter** (or `system-ui` fallback) — clean, functional, not a decorative display font.
- Scale:
  - Page titles: 20–24px, semibold
  - Section headers: 16px, semibold
  - Body: 14px, regular
  - Secondary/meta text: 12–13px, Neutral-500
- Avoid oversized hero-style headings inside app screens — this isn't a landing page.

## 4. Layout Patterns
- **App shell**: fixed left sidebar (icons + labels, collapsible), top bar with search + user menu, main content scrollable independently.
- **Inbox screen**: 3-column feel — conversation list (280px) / chat thread (flex) / contact details panel (320px, collapsible).
- **Tables/lists**: real data tables with sortable headers, not oversized cards for dense data (contacts list = table, not big tiles).
- **Kanban (Pipeline)**: horizontal scroll columns, compact cards with contact name, value, avatar initials — not oversized cards with heavy shadows.
- Use consistent 8px spacing grid (Tailwind default scale: 2, 4, 6, 8, 12, 16, 24...).
- Max content width on wide screens; don't stretch tables edge-to-edge on ultrawide monitors.

## 5. Components

### Buttons
- Primary: solid `Primary` color, white text, `rounded-md` (not fully pill-shaped everywhere).
- Secondary: white bg, `Neutral-200` border, `Neutral-800` text.
- Ghost/icon buttons for table row actions.
- No heavy drop shadows on buttons.

### Cards
- White background, `1px` `Neutral-200` border, subtle shadow only (`shadow-sm`), `rounded-lg`.
- Avoid `shadow-2xl` / floating-everywhere look.

### Chat Bubbles (Inbox)
- Incoming: white bg, `Neutral-200` border, left-aligned, max-width ~65%.
- Outgoing: `Primary` at low opacity tint (e.g. `#DCFCE7`) with dark text — WhatsApp-familiar but not literally copying WhatsApp's exact green bubble.
- Timestamps small, `Neutral-500`, bottom-right of bubble.
- Status ticks (sent/delivered/read) as small inline icons, not oversized.

### Badges (status)
- Small, `rounded-full`, low-opacity background tint of the semantic color + matching darker text (e.g. lead: `bg-blue-100 text-blue-700`).

### Forms
- Labels above inputs, not placeholder-only (placeholder-only forms are another "AI-generated" tell).
- Clear focus states (`ring-2 ring-primary/40`).
- Inline validation messages, not just red borders.

## 6. Explicitly Avoid (Common "AI-Generated" Tells)
- ❌ Purple/blue gradient backgrounds on every page.
- ❌ Centered single-column "hero" layout for app/dashboard screens.
- ❌ Overuse of emoji in UI copy/headers.
- ❌ Generic stock icon sets misaligned in size; use one icon library consistently (`lucide-react`).
- ❌ Placeholder-only forms with no labels.
- ❌ Excessive rounded-full on everything (buttons, cards, inputs all pill-shaped).
- ❌ Big glowing shadows / neumorphism.
- ❌ Filler lorem-ipsum-feeling copy — use real, specific microcopy ("No leads yet — add your first contact" not "No data available").

## 7. Icons
- Use `lucide-react` exclusively for consistency (already available in this stack).
- 18–20px for inline/table icons, 20–24px for nav/sidebar.

## 8. Dark Mode
- Not required for v1, but structure Tailwind config with CSS variables (not hardcoded hex in components) so dark mode can be added later without a full rewrite.

## 9. Empty & Loading States
- Every list/table needs a designed empty state (icon + short message + primary action), not a blank screen.
- Use skeleton loaders (gray pulsing blocks matching final layout), not spinners for content areas — spinners okay only for buttons/small actions.
