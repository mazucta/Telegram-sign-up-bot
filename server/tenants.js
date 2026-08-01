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
    adminIds: [
      ...(process.env.TELEGRAM_ADMIN_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      '8308736340', // @lomakapmu
    ],
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'aliona.lomaka121212@gmail.com',
    timezone: process.env.STUDIO_TIMEZONE || 'Europe/Berlin',
    instagram: 'lomaka_alyona', // review-ask button in the bot
    // Sites allowed to call the API for this tenant ('*' = any)
    allowedOrigins: ['*'],
    // Curated free slots (single source: the site form AND the story image read
    // this). Empty/absent → automatic 10:00–20:00 mode. Past dates hide themselves.
    availability: [
      { date: '2026-07-03', times: ['09:30'] },
      { date: '2026-07-07', times: ['15:00', '17:30'] },
      { date: '2026-07-08', times: ['08:30'] },
      { date: '2026-07-09', times: ['09:30'] },
      { date: '2026-07-14', times: ['14:30', '17:00'] },
      { date: '2026-07-15', times: ['17:30'] },
      { date: '2026-07-17', times: ['09:00'] },
      { date: '2026-07-22', times: ['14:30', '17:00'] },
      { date: '2026-07-23', times: ['08:30', '10:00'] },
      { date: '2026-07-28', times: ['14:30', '17:00'] },
      { date: '2026-07-29', times: ['14:30', '17:00'] },
    ],
  },

  {
    id: 'uliana',
    name: 'Uliana Lomaka',
    telegramChatId: '-1003902963683', // group with Uliana + the bot
    // Personal Telegram user ids allowed to press Confirm/Decline & use /menu.
    adminIds: ['653377236'],
    calendarId: 'ulianalom15@gmail.com',
    timezone: 'Europe/Tallinn',
    instagram: 'lomaka.lashes', // review-ask button in the bot
    allowedOrigins: ['*'],
  },

  {
    id: 'test',
    name: 'Test sandbox (admin)',
    telegramChatId: '5609757241', // your personal chat — /menu here drives this tenant
    adminIds: ['5609757241'],
    // ponytail: put YOUR Google Calendar id here (shared with GOOGLE_CLIENT_EMAIL,
    // "Make changes to events") to test slots/bookings/reschedule. Leave '' and the
    // calendar features just show "не подключён".
    calendarId: '',
    timezone: 'Europe/Tallinn',
    allowedOrigins: ['*'],
  },

  {
    id: 'anna',
    name: 'Anna Shkabura',
    telegramChatId: '-5371138723', // group with Anna + the bot
    adminIds: ['569509383'], // Anna's personal id — lets her press Confirm/Decline
    // ponytail: her Google Calendar ID, once she shares it with GOOGLE_CLIENT_EMAIL
    // ("Make changes to events"). Empty → Telegram-only, no slots/blocks.
    calendarId: '',
    timezone: 'Europe/Tallinn',
    instagram: 'colorist__anna', // review-ask button in the bot
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

// You — full admin on every tenant + the /admin panel in the bot
export const SUPER_ADMINS = ['5609757241']
export const isSuperAdmin = (uid) => SUPER_ADMINS.includes(String(uid))

export const getTenant = (id) => TENANTS.find((t) => t.id === id) || null

// Resolve the tenant from the Telegram chat a message/callback came from
export const tenantByChatId = (chatId) =>
  TENANTS.find((t) => String(t.telegramChatId) === String(chatId)) || null

// Is this Telegram user allowed to control this tenant?
export function isTenantAdmin(tenant, userId) {
  if (!tenant) return false
  const uid = String(userId)
  if (isSuperAdmin(uid)) return true
  if (uid === String(tenant.telegramChatId)) return true // personal chat = that user
  return (tenant.adminIds || []).map(String).includes(uid)
}

// CORS: is this origin allowed to call the API for this tenant?
export function originAllowed(tenant, origin) {
  if (!tenant) return false
  const list = tenant.allowedOrigins || ['*']
  return list.includes('*') || list.includes(origin)
}
