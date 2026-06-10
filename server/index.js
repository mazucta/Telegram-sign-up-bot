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

import { isCalendarConfigured, createPendingEvent, getAvailability } from './google-calendar.js'
import { isTelegramConfigured, sendBookingToMaster, handleUpdate, setupWebhook } from './telegram.js'
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

  const ip = req.ip || req.socket?.remoteAddress || 'unknown'
  const key = `${tenant.id}:${ip}`
  if (usedToday(key) >= MAX_BOOKINGS_PER_IP_PER_DAY) {
    return res.status(429).json({ ok: false, error: 'daily_limit' })
  }

  const booking = { name, contact, method, service, date, time, message }
  console.log(`📩 Booking [${tenant.id}]:`, booking)
  recordBooking(key)

  try {
    let event = null
    if (isCalendarConfigured() && tenant.calendarId) {
      event = await createPendingEvent(booking, tenant.calendarId, tenant.timezone)
    }
    if (isTelegramConfigured() && tenant.telegramChatId) {
      await sendBookingToMaster(booking, event, tenant)
    }
    return res.json({ ok: true })
  } catch (err) {
    console.error('Booking handling failed:', err)
    return res.json({ ok: true, warning: 'Saved with limited processing.' })
  }
})

app.get('/api/availability', async (req, res) => {
  const tenant = getTenant(String(req.query.tenant || ''))
  if (!tenant || !isCalendarConfigured() || !tenant.calendarId) {
    return res.json({ busy: [], daysOff: [] })
  }
  try {
    const data = await getAvailability(14, tenant.calendarId)
    res.set('Cache-Control', 'public, max-age=60')
    return res.json(data)
  } catch (err) {
    console.error('Availability failed:', err)
    return res.json({ busy: [], daysOff: [] })
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
})
