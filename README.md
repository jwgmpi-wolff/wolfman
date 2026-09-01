# Wolfman

Wolfman helps with money, tasks, goals, and habits. Your data stays on your device unless you turn on cloud sync.

## Install Wolfman

Pick your device. Do the one step under its name.

### Windows

Copy this whole line. Paste it into PowerShell. Press **Enter**.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/jwgmpi-wolff/wolfman/main/scripts/install-windows.ps1 | iex"
```

This gets every tool Wolfman needs. It also gets the AI models. The download is about 25 GB. Wolfman opens when it is done.

### Linux

Copy this whole line. Paste it into a terminal. Press **Enter**.

```bash
curl -fsSL https://raw.githubusercontent.com/jwgmpi-wolff/wolfman/main/scripts/install-linux.sh | bash
```

This works on Ubuntu, Debian, Fedora, Arch, and openSUSE. It gets every tool Wolfman needs. It also gets the AI models. The download is about 25 GB. Wolfman opens when it is done.

### Android

[Tap here to get the Android app.](https://raw.githubusercontent.com/jwgmpi-wolff/wolfman/main/releases/Wolfman-debug.apk)

Open the file. Tap **Install**. Your phone may ask you to allow this install.

Android cannot run Wolfman's large local AI models. The rest of the app still works.

### Mac, iPhone, iPad, or Chromebook

[Open Wolfman in your web browser.](https://jwgmpi-wolff.github.io/wolfman/)

Use your browser menu. Pick **Install app** or **Add to Home Screen**.

The web app cannot install the large local AI models for you. The rest of the app still works.

## What the desktop install does

The Windows and Linux commands get Git, Node.js 22, Ollama, Wolfman, and two AI models. They build the app, install it, and open it. Run the same command later to get a new Wolfman version. Your saved Wolfman data is not removed.

## Features

- Starts empty: no sample transactions, tasks, goals, or habits
- 50/30/20 budget pacing and transaction tracking as you enter data
- Savings goals, Eisenhower task planning, and weekly habits
- CSV/JSON transaction and dataset imports with local analysis
- Keyboard or voice requests only — Wolfman never volunteers unprompted suggestions
- Optional local Ollama agent with tools for finances, datasets, stocks, Microsoft 365, web search, and confirmed SMS
- Optional consented, read-only Microsoft 365 access (email, Teams chats, files) and public web page reading
- Offline-capable Progressive Web App (PWA)
- Optional passwordless, account-isolated cloud backup through Supabase

Wolfman provides educational analysis and is not a substitute for professional financial advice.

## Build it yourself

You need Node.js 22 or newer and npm.

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Cloud and Microsoft configuration are both optional. Without them, all data remains in browser local storage and Wolfman answers only from what you type or say, or a public URL you provide.

## Change the local AI

The one-step desktop install sets up Ollama for you. To use other models, set `VITE_OLLAMA_URL`, `VITE_OLLAMA_MODEL`, or `VITE_OLLAMA_VISION_MODEL` in `.env.local` before building the app.

The Windows desktop app starts the local Ollama server when needed. Browser development requires Ollama to already be running. Wolfman can inspect pasted or attached images, sample frames from attached videos and direct video-file URLs, and inspect representative thumbnails for YouTube links. Remote hosts must permit browser media access. If Ollama or the configured model is unavailable, Wolfman uses its built-in text request handlers instead.

## Validate

```powershell
npm run lint
npm run build
```

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
