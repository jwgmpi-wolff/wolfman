import { PublicClientApplication, type AccountInfo } from '@azure/msal-browser'

const clientId = import.meta.env.VITE_MICROSOFT_CLIENT_ID
const tenantId = import.meta.env.VITE_MICROSOFT_TENANT_ID || 'common'
const scopes = ['User.Read', 'Mail.Read', 'Chat.Read', 'Files.Read.All', 'Calendars.Read']
const graphRoot = 'https://graph.microsoft.com/v1.0'

export const microsoftEnabled = Boolean(clientId)

const client = microsoftEnabled
  ? new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        redirectUri: new URL(import.meta.env.BASE_URL, window.location.origin).href,
      },
      cache: { cacheLocation: 'sessionStorage' },
    })
  : null

let initialization: Promise<void> | null = null

async function initialize() {
  if (!client) throw new Error('Microsoft access is not configured.')
  initialization ??= client.initialize()
  await initialization
  return client
}

export async function getMicrosoftAccount() {
  const app = await initialize()
  return app.getActiveAccount() ?? app.getAllAccounts()[0] ?? null
}

export async function connectMicrosoft() {
  const app = await initialize()
  try {
    const result = await app.loginPopup({ scopes, prompt: 'select_account' })
    app.setActiveAccount(result.account)
    return result.account
  } catch (error) {
    // An abandoned/blocked popup can leave MSAL believing an interaction is still running,
    // which silently blocks every future attempt until this stuck flag is cleared.
    if (error instanceof Error && error.name === 'BrowserAuthError' && 'errorCode' in error && error.errorCode === 'interaction_in_progress') {
      sessionStorage.removeItem('msal.interaction.status')
      throw new Error('The previous sign-in attempt did not complete. Try connecting again.')
    }
    throw error
  }
}

export async function disconnectMicrosoft() {
  const app = await initialize()
  const account = await getMicrosoftAccount()
  if (account) await app.logoutPopup({ account })
}

async function accessToken(account: AccountInfo) {
  const app = await initialize()
  try {
    return (await app.acquireTokenSilent({ account, scopes })).accessToken
  } catch {
    return (await app.acquireTokenPopup({ account, scopes })).accessToken
  }
}

async function graph<T>(path: string) {
  const account = await getMicrosoftAccount()
  if (!account) throw new Error('Connect your Microsoft account in Settings first.')
  const response = await fetch(`${graphRoot}${path}`, {
    headers: { Authorization: `Bearer ${await accessToken(account)}` },
  })
  if (!response.ok) {
    if (response.status === 403) throw new Error('Microsoft denied this read request. An administrator may need to approve the requested permission.')
    throw new Error(`Microsoft Graph request failed (${response.status}).`)
  }
  return response.json() as Promise<T>
}

type GraphList<T> = { value: T[] }

function escapeMarkdown(value: string | null | undefined) {
  return (value || '(untitled)').replace(/[|\r\n]+/g, ' ').trim()
}

async function readMail() {
  const result = await graph<GraphList<{ subject?: string; bodyPreview?: string; from?: { emailAddress?: { name?: string } }; receivedDateTime?: string }>>(
    '/me/messages?$select=subject,bodyPreview,from,receivedDateTime&$orderby=receivedDateTime%20desc&$top=10',
  )
  if (!result.value.length) return 'No email was returned for your account.'
  return `**Recent email**\n\n${result.value.map((message) =>
    `- **${escapeMarkdown(message.subject)}** from ${escapeMarkdown(message.from?.emailAddress?.name)} · ${message.receivedDateTime ? new Date(message.receivedDateTime).toLocaleString() : 'date unavailable'}\n  ${escapeMarkdown(message.bodyPreview).slice(0, 280)}`,
  ).join('\n')}`
}

async function readChats() {
  const result = await graph<GraphList<{ id: string; topic?: string; chatType?: string; lastUpdatedDateTime?: string }>>(
    '/me/chats?$select=id,topic,chatType,lastUpdatedDateTime&$orderby=lastUpdatedDateTime%20desc&$top=10',
  )
  if (!result.value.length) return 'No Teams chats were returned for your account.'
  const chats = await Promise.all(result.value.slice(0, 3).map(async (chat) => {
    const messages = await graph<GraphList<{ body?: { content?: string }; createdDateTime?: string; from?: { user?: { displayName?: string } } }>>(
      `/me/chats/${encodeURIComponent(chat.id)}/messages?$top=3`,
    )
    const rows = messages.value.map((message) => {
      const content = new DOMParser().parseFromString(message.body?.content || '', 'text/html').body.textContent || ''
      return `  - ${escapeMarkdown(message.from?.user?.displayName)}: ${escapeMarkdown(content).slice(0, 400)}`
    })
    return `- **${escapeMarkdown(chat.topic || chat.chatType)}** · ${chat.lastUpdatedDateTime ? new Date(chat.lastUpdatedDateTime).toLocaleString() : 'date unavailable'}\n${rows.join('\n') || '  - No messages returned.'}`
  }))
  return `**Recent Teams chats**\n\n${chats.join('\n')}`
}

async function readFiles() {
  const result = await graph<GraphList<{ name?: string; lastModifiedDateTime?: string; webUrl?: string }>>(
    '/me/drive/recent?$select=name,lastModifiedDateTime,webUrl&$top=10',
  )
  if (!result.value.length) return 'No recent files were returned for your account.'
  return `**Recent files**\n\n${result.value.map((file) => {
    const name = escapeMarkdown(file.name)
    const label = file.webUrl ? `[${name}](${file.webUrl})` : name
    return `- **${label}** · ${file.lastModifiedDateTime ? new Date(file.lastModifiedDateTime).toLocaleString() : 'date unavailable'}`
  }).join('\n')}`
}

async function readProfile() {
  const profile = await graph<{ displayName?: string; mail?: string; userPrincipalName?: string }>(
    '/me?$select=displayName,mail,userPrincipalName',
  )
  return `**Microsoft account**\n\n- Name: ${escapeMarkdown(profile.displayName)}\n- Account: ${escapeMarkdown(profile.mail || profile.userPrincipalName)}`
}

async function readCalendar() {
  const now = new Date()
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const result = await graph<GraphList<{ subject?: string; start?: { dateTime?: string }; end?: { dateTime?: string }; location?: { displayName?: string }; isAllDay?: boolean }>>(
    `/me/calendarview?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$select=subject,start,end,location,isAllDay&$orderby=start/dateTime&$top=15`,
  )
  if (!result.value.length) return 'No upcoming events in the next 7 days.'
  return `**Upcoming calendar events (next 7 days)**\n\n${result.value.map((event) => {
    const when = event.isAllDay
      ? 'All day'
      : event.start?.dateTime && event.end?.dateTime
        ? `${new Date(event.start.dateTime).toLocaleString()} – ${new Date(event.end.dateTime).toLocaleTimeString()}`
        : 'Time unavailable'
    const where = event.location?.displayName ? ` · ${escapeMarkdown(event.location.displayName)}` : ''
    return `- **${escapeMarkdown(event.subject)}** · ${when}${where}`
  }).join('\n')}`
}

export async function answerMicrosoftRequest(input: string) {
  const normalized = input.toLowerCase()
  if (/\b(email|mail|inbox|outlook)\b/.test(normalized)) return readMail()
  if (/\b(teams?|chat|message)\b/.test(normalized)) return readChats()
  if (/\b(files?|documents?|onedrive|sharepoint)\b/.test(normalized)) return readFiles()
  if (/\b(calendar|events?|schedule|meetings?|agenda)\b/.test(normalized)) return readCalendar()
  if (/\b(account|profile|who am i)\b/.test(normalized)) return readProfile()
  return null
}

export async function readRequestedUrl(input: string) {
  const match = input.match(/https?:\/\/[^\s<>)]+/i)
  if (!match) return null
  let response: Response
  try {
    response = await fetch(match[0])
  } catch {
    throw new Error('The site blocked direct browser access. Wolfman can read only public pages that allow cross-origin requests.')
  }
  if (!response.ok) throw new Error(`The site returned ${response.status}.`)
  const type = response.headers.get('content-type') || ''
  if (!type.includes('text/')) throw new Error('Wolfman can currently read text web pages only.')
  const html = await response.text()
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent?.replace(/\s+/g, ' ').trim() || ''
  return text ? `**Content from ${match[0]}**\n\n${text.slice(0, 6000)}` : 'The page did not contain readable text.'
}