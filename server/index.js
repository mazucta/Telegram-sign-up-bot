// Booking Hub — one shared backend for many masters' sites.
//
//  • POST /api/booking { tenant, ...form } → event in that master's calendar
//                                          → Telegram card to that master
//  • GET  /api/availability?tenant=…        → busy slots / days off
//  • POST /api/telegram/webhook             → the one bot's updates (all masters)
//
// This service has NO frontend of its own. Masters' sites (any stack, deployed
// as static sites) call this API cross-origin (CORS is open). Add masters in
// server/tenants.js. Shared secrets (bot token, service account) live in env.

import express from 'express'

import {
  isCalendarConfigured,
  createPendingEvent,
  getAvailability,
  getCurated,
  getDayStatus,
  filterCurated,
  marks,
  serviceMinutes,
  nowInTz,
  SCAN_DAYS,
} from './google-calendar.js'
import {
  isTelegramConfigured,
  sendBookingToMaster,
  handleUpdate,
  setupWebhook,
  getBotUsername,
  runPeriodicTasks,
} from './telegram.js'
import { TENANTS, getTenant } from './tenants.js'

const app = express()
const PORT = process.env.PORT || 3001
app.set('trust proxy', true)

const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ''
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || ''

// Anti-spam: max bookings per IP+tenant per day (in-memory; resets daily)
const MAX_BOOKINGS_PER_IP_PER_DAY = 2
const bookingCounts = new Map()
function usedToday(key) {
  const today = new Date().toISOString().slice(0, 10)
  const rec = bookingCounts.get(key)
  return rec && rec.date === today ? rec.count : 0
}
function recordBooking(key) {
  const today = new Date().toISOString().slice(0, 10)
  bookingCounts.set(key, { date: today, count: usedToday(key) + 1 })
  if (bookingCounts.size > 2000) {
    for (const [k, v] of bookingCounts) if (v.date !== today) bookingCounts.delete(k)
  }
}

app.use(express.json())

// Open CORS so any master's static site (any origin) can call the API
app.use('/api', (req, res, next) => {
  const origin = req.get('Origin')
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Vary', 'Origin')
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type')
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// Tiny status page (no master content lives here)
app.get('/', (_req, res) => {
  res.type('text/plain').send(
    `Booking Hub · tenants: ${TENANTS.length} · calendar: ${
      isCalendarConfigured() ? 'on' : 'off'
    } · telegram: ${isTelegramConfigured() ? 'on' : 'off'}`
  )
})

app.post('/api/booking', async (req, res) => {
  const { tenant: tenantId, name, contact, method, service, date, time, message } = req.body || {}
  const tenant = getTenant(tenantId)
  if (!tenant) return res.status(400).json({ ok: false, error: 'unknown_tenant' })
  if (!name || !contact) {
    return res.status(400).json({ ok: false, error: 'Name and contact are required.' })
  }

  // Reject slots already in the past (today, studio timezone)
  if (date && time) {
    const { date: today, hour } = nowInTz(tenant.timezone)
    if (date < today || (date === today && parseInt(time, 10) <= hour)) {
      return res.status(400).json({ ok: false, error: 'slot_in_past' })
    }
  }

  const ip = req.ip || req.socket?.remoteAddress || 'unknown'
  const key = `${tenant.id}:${ip}`
  if (usedToday(key) >= MAX_BOOKINGS_PER_IP_PER_DAY) {
    return res.status(429).json({ ok: false, error: 'daily_limit' })
  }

  const booking = { name, contact, method, service, date, time, message }
  console.log(`📩 Booking [${tenant.id}]:`, booking)

  const useCalendar = isCalendarConfigured() && tenant.calendarId

  // Reject slots already taken / blocked / on a day off (no silent double-booking)
  if (useCalendar && date && time) {
    const { dayoff, status } = await getDayStatus(date, tenant.calendarId).catch(() => ({ dayoff: false, status: {} }))
    // The whole procedure must fit: a 4 h Air Touch starting an hour before an
    // existing booking overlaps it even though its start time looks free.
    const busy = marks(time, serviceMinutes(service)).some((t) => status[t])
    if (dayoff || busy) return res.status(409).json({ ok: false, error: 'slot_taken' })
  }

  // Calendar and Telegram are independent: one failing must not lose the other.
  let event = null
  let calendarFailed = false
  if (useCalendar) {
    try {
      event = await createPendingEvent(booking, tenant.calendarId, tenant.timezone)
    } catch (err) {
      calendarFailed = true
      console.error(`Calendar insert failed [${tenant.id}]:`, err)
    }
  }
  let masterNotified = false
  if (isTelegramConfigured() && tenant.telegramChatId) {
    const sent = await sendBookingToMaster(booking, event, tenant).catch((err) => {
      console.error(`Telegram send failed [${tenant.id}]:`, err)
      return null
    })
    masterNotified = Boolean(sent?.ok)
  }

  // Nothing recorded anywhere → tell the client the truth so the booking
  // isn't silently lost (the site shows an error and they can retry/DM).
  if (!event && !masterNotified) {
    return res.status(502).json({ ok: false, error: calendarFailed ? 'calendar_failed' : 'not_configured' })
  }

  recordBooking(key)
  // Deep link the site shows after booking: client taps it, presses Start,
  // and the bot can then push confirm/reschedule/cancel updates to them.
  let notifyUrl = ''
  if (event?.id) {
    const bot = await getBotUsername().catch(() => '')
    if (bot) notifyUrl = `https://t.me/${bot}?start=${tenant.id}_${event.id}`
  }
  return res.json({ ok: true, notifyUrl })
})

app.get('/api/availability', async (req, res) => {
  const tenant = getTenant(String(req.query.tenant || ''))
  if (!tenant) return res.json({ busy: [], daysOff: [], curated: [] })
  const curated = tenant.availability || []
  if (!isCalendarConfigured() || !tenant.calendarId) {
    return res.json({ busy: [], daysOff: [], curated })
  }
  try {
    // Master's per-date times come from their calendar (set via the bot);
    // the hardcoded tenant list is only a fallback until they set them.
    const [data, stored] = await Promise.all([
      getAvailability(SCAN_DAYS, tenant.calendarId, tenant.timezone),
      getCurated(tenant.calendarId),
    ])
    const source = stored.length ? stored : curated
    res.set('Cache-Control', 'public, max-age=60')
    return res.json({ ...data, curated: filterCurated(source, data, tenant.timezone) })
  } catch (err) {
    console.error('Availability failed:', err)
    return res.json({ busy: [], daysOff: [], curated })
  }
})

app.post('/api/telegram/webhook', (req, res) => {
  if (WEBHOOK_SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) {
    return res.sendStatus(401)
  }
  res.sendStatus(200)
  handleUpdate(req.body)
})

app.listen(PORT, async () => {
  console.log(`✅ Booking Hub on http://localhost:${PORT}`)
  console.log(
    `   Calendar: ${isCalendarConfigured() ? 'on' : 'off'} · Telegram: ${isTelegramConfigured() ? 'on' : 'off'} · Tenants: ${TENANTS.length}`
  )
  if (isTelegramConfigured() && PUBLIC_URL) {
    try {
      await setupWebhook(PUBLIC_URL, WEBHOOK_SECRET)
    } catch (err) {
      console.error('Webhook setup failed:', err)
    }
  }
  // Client reminders / review asks / morning summaries (paid instance — always awake)
  runPeriodicTasks()
  setInterval(runPeriodicTasks, 15 * 60e3)
})
