# Wolfman

An installable, local-first financial and personal assistant for Windows, Android, and modern browsers.

## Features

- 50/30/20 budget pacing and transaction tracking
- Savings goals, Eisenhower task planning, and weekly habits
- Daily Briefing, Weekly Review, and purchase opportunity-cost SOPs
- Offline-capable Progressive Web App (PWA)
- Optional passwordless, account-isolated cloud backup through Supabase

Wolfman provides educational analysis and is not a substitute for professional financial advice.

## Run locally

Prerequisites: Node.js 22 or newer and npm.

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Cloud configuration is optional. Without it, all data remains in browser local storage.

## Validate

```powershell
npm run lint
npm run build
```

## Install

- **Windows:** Open the deployed site in Edge or Chrome, select the install icon in the address bar, and choose **Install**.
- **Android:** Open the deployed site in Chrome, open the browser menu, and choose **Install app** or **Add to Home screen**.

## Enable private cloud sync

1. Create a Supabase project.
2. Run [supabase/schema.sql](supabase/schema.sql) in the SQL editor.
3. Copy `.env.example` to `.env.local` and enter the project URL and public anon key.
4. Add the deployed URL to Supabase Authentication > URL Configuration.
5. For GitHub Pages, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as repository Actions secrets.

The SQL schema enables row-level security and denies anonymous access. Never expose a service-role key in a browser application.

Sync is intentionally manual: **Upload this device** replaces the cloud backup, and **Restore from cloud** replaces local data. This prevents an older device from silently overwriting newer records.

## Deploy

The included workflow deploys `main` to GitHub Pages. In repository Settings > Pages, set the source to **GitHub Actions**. The app uses the repository name as its production base path.

## Data and privacy

- Local data is stored in the browser profile.
- Cloud data is associated with the authenticated user ID and protected by Supabase row-level security.
- No financial credentials or bank login data are requested or stored.
- Clearing browser storage removes unsynced local data.
