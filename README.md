# Wolfman

An installable, local-first financial and personal assistant for Windows, Android, and modern browsers.

## Features

- Starts empty: no sample transactions, tasks, goals, or habits
- 50/30/20 budget pacing and transaction tracking as you enter data
- Savings goals, Eisenhower task planning, and weekly habits
- Keyboard or voice requests only — Wolfman never volunteers unprompted suggestions
- Optional consented, read-only Microsoft 365 access (email, Teams chats, files) and public web page reading
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

Cloud and Microsoft configuration are both optional. Without them, all data remains in browser local storage and Wolfman answers only from what you type or say, or a public URL you provide.

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

## Enable Microsoft 365 access

1. Register a single-tenant or multi-tenant **public client (SPA)** app in Microsoft Entra ID, with no client secret.
2. Add a **Single-page application** redirect URI matching your dev URL (`http://localhost:5173/`) and deployed URL.
3. Grant the delegated Microsoft Graph permissions `User.Read`, `Mail.Read`, `Chat.Read`, and `Files.Read.All`.
4. Copy `.env.example` to `.env.local` and enter the application (client) ID and tenant ID.
5. For GitHub Pages, add `VITE_MICROSOFT_CLIENT_ID` and `VITE_MICROSOFT_TENANT_ID` as repository Actions secrets.

Each user connects their own Microsoft account from **Settings > Connections** and consents to the requested read-only scopes. Wolfman only reads email, Teams chats, or files when the user's message asks for them, and never stores that content locally.

## Deploy

The included workflow deploys `main` to GitHub Pages. In repository Settings > Pages, set the source to **GitHub Actions**. The app uses the repository name as its production base path.

## Data and privacy

- Local data is stored in the browser profile.
- Cloud data is associated with the authenticated user ID and protected by Supabase row-level security.
- No financial credentials or bank login data are requested or stored.
- Microsoft tokens are cached only in browser session storage and are cleared when the tab session ends or you disconnect.
- Wolfman reads Microsoft or public web content only in direct response to a user request, and does not persist that content in local storage.
- Clearing browser storage removes unsynced local data.
