// Registry of masters (tenants) served by the one shared bot.
//
// To add a master:
//   1. Have them press Start on the bot (or add the bot to their group) and tell
//      you their Telegram id / group id (via @userinfobot / @getidsbot).
//   2. Have them share their Google Calendar with the service account email
//      (GOOGLE_CLIENT_EMAIL) — "Make changes to events". Copy their Calendar ID.
//   3. Add an entry below and redeploy. That's it.
//
// Secrets (bot token, service-account key) live in env and are shared by all
// tenants. Calendar ids / chat ids are not secret, so they can live here.
//
// The first master keeps working from the existing env vars (back-compat).

export const TENANTS = [
  {
    id: 'alyona',
    name: 'Lomaka Alyona',
    // Where booking notifications go (personal chat id or a group id)
    telegramChatId: process.env.TELEGRAM_MASTER_CHAT_ID || '',
    // Telegram user ids allowed to press buttons / use /menu (master + you)
    adminIds: (process.env.TELEGRAM_ADMIN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    calendarId: process.env.GOOGLE_CALENDAR_ID || '',
    timezone: process.env.STUDIO_TIMEZONE || 'Europe/Berlin',
    // Sites allowed to call the API for this tenant ('*' = any)
    allowedOrigins: ['*'],
  },

  {
    id: 'uliana',
    name: 'Uliana Lomaka',
    telegramChatId: '-1003902963683', // group with Uliana + the bot
    // Personal Telegram user ids allowed to press Confirm/Decline & use /menu.
    // TODO: add Uliana's personal id (she sends /start to the bot in a PRIVATE
    // chat — the bot replies with her id). Without it, buttons in the group do
    // nothing.
    adminIds: [],
    // TODO: paste Uliana's Google Calendar ID (Calendar settings → Integrate
    // calendar → Calendar ID). Empty = Telegram notifications only, no calendar.
    calendarId: '',
    timezone: 'Europe/Tallinn',
    allowedOrigins: ['*'],
  },

  // --- Add more masters here ---
  // {
  //   id: 'olena',
  //   name: 'Olena Lomaka',
  //   telegramChatId: '-1001234567890',          // her group id (or personal id)
  //   adminIds: ['8917908685', '5609757241'],     // her id + yours
  //   calendarId: 'olena@gmail.com',              // her Calendar ID
  //   timezone: 'Europe/Tallinn',
  //   allowedOrigins: ['https://olena-site.onrender.com'],
  // },
]

export const getTenant = (id) => TENANTS.find((t) => t.id === id) || null

// Resolve the tenant from the Telegram chat a message/callback came from
export const tenantByChatId = (chatId) =>
  TENANTS.find((t) => String(t.telegramChatId) === String(chatId)) || null

// Is this Telegram user allowed to control this tenant?
export function isTenantAdmin(tenant, userId) {
  if (!tenant) return false
  const uid = String(userId)
  if (uid === String(tenant.telegramChatId)) return true // personal chat = that user
  return (tenant.adminIds || []).map(String).includes(uid)
}

// CORS: is this origin allowed to call the API for this tenant?
export function originAllowed(tenant, origin) {
  if (!tenant) return false
  const list = tenant.allowedOrigins || ['*']
  return list.includes('*') || list.includes(origin)
}
