// Google Calendar integration (multi-tenant).
//
// One shared service account (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY) accesses
// every master's calendar that has been shared with it. Each call takes the
// tenant's `calendarId` (and timezone); both default to the env values so the
// first master keeps working unchanged.
//
// The calendar is the single source of truth for availability:
//  • bookings (pending/confirmed) occupy their slot
//  • the master can block a slot   → a "🚫 Blocked" event
//  • the master can take a day off  → an all-day "🌴 Day off" event
// Each event we create stores its slot (slotDate/slotTime) in extendedProperties,
// so availability matching is exact and timezone-independent.

import { google } from 'googleapis'

const PENDING_PREFIX = '🟡 NEW · '
const CONFIRMED_PREFIX = '✅ '
const DEFAULT_TZ = process.env.STUDIO_TIMEZONE || 'Europe/Berlin'
const DEFAULT_CAL = () => process.env.GOOGLE_CALENDAR_ID

// Bookable hours (shared by bot, website and story). Every two hours, 10:00–20:00.
export const TIME_SLOTS = ['10:00', '12:00', '14:00', '16:00', '18:00', '20:00']
const SLOT_HOURS = 2

// How far ahead bookings are offered (site availability, bot menu, story).
export const WINDOW_DAYS = 30

// Current { date: 'YYYY-MM-DD', hour: 0-23 } in a given IANA timezone.
export function nowInTz(tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  const get = (t) => parts.find((p) => p.type === t)?.value
  let hour = parseInt(get('hour'), 10)
  if (hour === 24) hour = 0 // some runtimes emit 24 at midnight
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour }
}
export const localToday = (tz = DEFAULT_TZ) => nowInTz(tz).date

// Service-account credentials are global (shared across tenants)
export function isCalendarConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY)
}

function getCalendar() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  })
  return google.calendar({ version: 'v3', auth })
}

// ---- date/time helpers ------------------------------------------------------
const normTime = (t) => {
  const [h, m] = String(t).split(':')
  return `${String(h).padStart(2, '0')}:${m}`
}
const addSlotHours = (t) => {
  const [h, m] = t.split(':').map(Number)
  const eh = Math.min(h + SLOT_HOURS, 23)
  return `${String(eh).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
export const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function slot(date, time, tz) {
  const t = /^\d{1,2}:\d{2}$/.test(time || '') ? normTime(time) : '11:00'
  return {
    date,
    time: t,
    start: { dateTime: `${date}T${t}:00`, timeZone: tz },
    end: { dateTime: `${date}T${addSlotHours(t)}:00`, timeZone: tz },
  }
}

const METHOD_LABELS = { telegram: 'Telegram', instagram: 'Instagram', whatsapp: 'WhatsApp' }

function buildDescription(booking) {
  return [
    `Client: ${booking.name}`,
    `${METHOD_LABELS[booking.method] || 'WhatsApp'}: ${booking.contact}`,
    `Service: ${booking.service || '-'}`,
    `Message: ${booking.message || '-'}`,
  ].join('\n')
}

async function listWindow(fromISO, toISO, calendarId) {
  const res = await getCalendar().events.list({
    calendarId,
    timeMin: fromISO,
    timeMax: toISO,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  })
  return res.data.items || []
}

// ---- bookings ---------------------------------------------------------------

export async function createPendingEvent(booking, calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ) {
  const s = slot(booking.date, booking.time, tz)
  const res = await getCalendar().events.insert({
    calendarId,
    requestBody: {
      summary: `${PENDING_PREFIX}${booking.service || 'Booking'} — ${booking.name}`,
      description: buildDescription(booking),
      start: s.start,
      end: s.end,
      colorId: '5',
      extendedProperties: {
        private: {
          status: 'pending',
          method: booking.method || 'whatsapp',
          contact: booking.contact || '',
          clientName: booking.name || '',
          service: booking.service || '',
          slotDate: s.date,
          slotTime: s.time,
        },
      },
    },
  })
  return res.data
}

export async function getEvent(eventId, calendarId = DEFAULT_CAL()) {
  const res = await getCalendar().events.get({ calendarId, eventId })
  return res.data
}

export async function confirmEvent(eventId, { date, time } = {}, calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ) {
  const ev = await getEvent(eventId, calendarId)
  const cleanSummary = (ev.summary || '').replace(PENDING_PREFIX, '')
  const priv = { ...(ev.extendedProperties?.private || {}), status: 'confirmed' }
  const requestBody = {
    summary: cleanSummary.startsWith(CONFIRMED_PREFIX) ? cleanSummary : `${CONFIRMED_PREFIX}${cleanSummary}`,
    colorId: '10',
  }
  if (date) {
    const s = slot(date, time || '11:00', tz)
    requestBody.start = s.start
    requestBody.end = s.end
    priv.slotDate = s.date
    priv.slotTime = s.time
  }
  requestBody.extendedProperties = { private: priv }
  const res = await getCalendar().events.patch({ calendarId, eventId, requestBody })
  return res.data
}

export async function deleteEvent(eventId, calendarId = DEFAULT_CAL()) {
  await getCalendar().events.delete({ calendarId, eventId })
}

// Active client bookings (pending + confirmed) in the upcoming window, sorted by
// time. Blocks and days-off are excluded — this is only real client records, so
// the master can reschedule or cancel them from the menu.
export async function listBookings(days = WINDOW_DAYS, calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ) {
  if (!isCalendarConfigured() || !calendarId) return []
  const now = Date.now()
  const items = await listWindow(
    new Date(now - 6 * 3600e3).toISOString(),
    new Date(now + (days + 1) * 24 * 3600e3).toISOString(),
    calendarId
  )
  const bookings = []
  for (const ev of items) {
    const p = ev.extendedProperties?.private || {}
    if (p.type === 'block' || p.type === 'dayoff') continue
    if (!p.clientName) continue
    bookings.push({
      id: ev.id,
      status: p.status || 'confirmed',
      clientName: p.clientName || '',
      service: p.service || '',
      method: p.method || 'whatsapp',
      contact: p.contact || '',
      date: p.slotDate || (ev.start?.dateTime || '').slice(0, 10),
      time: p.slotTime || '',
    })
  }
  return bookings.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
}

// ---- custom bookable times (per master) -------------------------------------
//
// Each master can choose which start times appear on their site. We persist the
// list inside their own calendar as a marker event (type=slotsconfig) on a fixed
// far-past date, so it never shows up in the 30-day availability window. When a
// master hasn't set anything, TIME_SLOTS is the default.

const SLOTS_CONFIG_DATE = '2000-01-01'

async function findConfigEvent(type, calendarId) {
  const res = await getCalendar().events.list({
    calendarId,
    privateExtendedProperty: `type=${type}`,
    maxResults: 5,
    singleEvents: true,
  })
  return (res.data.items || [])[0] || null
}

const findSlotsConfig = (calendarId) => findConfigEvent('slotsconfig', calendarId)

export async function getSlots(calendarId = DEFAULT_CAL()) {
  if (!isCalendarConfigured() || !calendarId) return TIME_SLOTS
  try {
    const ev = await findSlotsConfig(calendarId)
    const list = (ev?.extendedProperties?.private?.slots || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return list.length ? list : TIME_SLOTS
  } catch {
    return TIME_SLOTS
  }
}

export async function setSlots(slots, calendarId = DEFAULT_CAL()) {
  const clean = [...new Set(slots.map(normTime))].sort()
  if (!clean.length) throw new Error('no_slots')
  const requestBody = {
    summary: '⏳ Booking time slots (config)',
    start: { date: SLOTS_CONFIG_DATE },
    end: { date: addDays(SLOTS_CONFIG_DATE, 1) },
    transparency: 'transparent',
    extendedProperties: { private: { type: 'slotsconfig', slots: clean.join(',') } },
  }
  const ev = await findSlotsConfig(calendarId)
  if (ev) await getCalendar().events.patch({ calendarId, eventId: ev.id, requestBody })
  else await getCalendar().events.insert({ calendarId, requestBody })
  return clean
}

// ---- curated per-date availability (per master) -------------------------------
//
// The exact {date, times[]} list the site's booking form shows. Stored like
// slotsconfig — a marker event (type=availconfig) on a far-past date — but the
// JSON lives in the event description (extendedProperties values cap at 1KB,
// too small for a month of dates).

export async function getCurated(calendarId = DEFAULT_CAL()) {
  if (!isCalendarConfigured() || !calendarId) return []
  try {
    const ev = await findConfigEvent('availconfig', calendarId)
    const list = JSON.parse(ev?.description || '[]')
    return Array.isArray(list) ? list.filter((s) => s?.date && Array.isArray(s.times)) : []
  } catch {
    return []
  }
}

// ponytail: per-calendar write queue — serializes read-modify-write on the one
// availconfig event so rapid taps can't duplicate it or lose a toggle.
const curatedQueues = new Map()
function queueCurated(calendarId, fn) {
  const next = (curatedQueues.get(calendarId) || Promise.resolve()).then(fn, fn)
  curatedQueues.set(calendarId, next.catch(() => {}))
  return next
}

/** Replaces the whole curated list (dates sorted, times deduped, past dates dropped). */
export const saveCurated = (entries, calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ) =>
  queueCurated(calendarId, () => writeCurated(entries, calendarId, tz))

async function writeCurated(entries, calendarId, tz) {
  const today = localToday(tz)
  const byDate = new Map()
  for (const e of entries || []) {
    if (!e?.date || e.date < today) continue
    const times = [...new Set((e.times || []).map(normTime))].sort()
    if (times.length) byDate.set(e.date, times)
  }
  const clean = [...byDate.keys()].sort().map((date) => ({ date, times: byDate.get(date) }))
  const requestBody = {
    summary: '🗓 Site availability (config)',
    description: JSON.stringify(clean),
    start: { date: SLOTS_CONFIG_DATE },
    end: { date: addDays(SLOTS_CONFIG_DATE, 1) },
    transparency: 'transparent',
    extendedProperties: { private: { type: 'availconfig' } },
  }
  const ev = await findConfigEvent('availconfig', calendarId)
  if (ev) await getCalendar().events.patch({ calendarId, eventId: ev.id, requestBody })
  else await getCalendar().events.insert({ calendarId, requestBody })
  return clean
}

/** Toggles one time on one date; returns the date's new times. */
export const toggleCuratedTime = (date, time, calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ) =>
  queueCurated(calendarId, async () => {
    const list = await getCurated(calendarId)
    const t = normTime(time)
    const day = list.find((s) => s.date === date)
    if (day && day.times.includes(t)) day.times = day.times.filter((x) => x !== t)
    else if (day) day.times.push(t)
    else list.push({ date, times: [t] })
    const saved = await writeCurated(list, calendarId, tz)
    return saved.find((s) => s.date === date)?.times || []
  })

/** Hides curated slots the client can no longer book: taken times, days off, the past.
 *  A date whose times are all taken stays in the list (empty) so the sites remain in
 *  curated mode instead of silently reverting to open booking. */
export function filterCurated(source, { busy = [], daysOff = [] } = {}, tz = DEFAULT_TZ) {
  const busySet = new Set(busy)
  const offSet = new Set(daysOff)
  const { date: today, hour } = nowInTz(tz)
  return (source || [])
    .map((s) => ({
      date: s.date,
      times: (s.times || []).filter(
        (t) => !busySet.has(`${s.date} ${t}`) && !(s.date === today && parseInt(t, 10) <= hour)
      ),
    }))
    .filter((s) => s.date >= today && !offSet.has(s.date))
}

// ---- availability (blocks, days off, busy slots) ----------------------------

export async function getAvailability(days = WINDOW_DAYS, calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ) {
  if (!isCalendarConfigured() || !calendarId) return { busy: [], daysOff: [], slots: TIME_SLOTS }
  const now = Date.now()
  const items = await listWindow(
    new Date(now - 24 * 3600e3).toISOString(),
    new Date(now + (days + 1) * 24 * 3600e3).toISOString(),
    calendarId
  )
  const busy = new Set()
  const daysOff = new Set()
  for (const ev of items) {
    const p = ev.extendedProperties?.private || {}
    if (p.type === 'dayoff' && p.dayoff) {
      daysOff.add(p.dayoff)
      continue
    }
    if (ev.start?.date && !ev.start?.dateTime) {
      daysOff.add(ev.start.date)
      continue
    }
    if (p.slotDate && p.slotTime) busy.add(`${p.slotDate} ${p.slotTime}`)
  }
  // Today's already-started slots can't be booked (studio-timezone "now")
  const slots = await getSlots(calendarId)
  const { date: today, hour } = nowInTz(tz)
  for (const t of slots) {
    if (parseInt(t, 10) <= hour) busy.add(`${today} ${t}`)
  }
  return { busy: [...busy], daysOff: [...daysOff], slots }
}

export async function getDayStatus(date, calendarId = DEFAULT_CAL()) {
  const items = await listWindow(`${addDays(date, -1)}T00:00:00Z`, `${addDays(date, 2)}T00:00:00Z`, calendarId)
  let dayoff = false
  const status = {}
  for (const ev of items) {
    const p = ev.extendedProperties?.private || {}
    if ((p.type === 'dayoff' && p.dayoff === date) || ev.start?.date === date) dayoff = true
    if (p.slotDate === date && p.slotTime) status[p.slotTime] = p.type === 'block' ? 'blocked' : 'booked'
  }
  return { dayoff, status }
}

async function createBlock(date, time, calendarId, tz) {
  const s = slot(date, time, tz)
  await getCalendar().events.insert({
    calendarId,
    requestBody: {
      summary: '🚫 Заблокировано',
      start: s.start,
      end: s.end,
      colorId: '8',
      extendedProperties: { private: { type: 'block', slotDate: s.date, slotTime: s.time } },
    },
  })
}

export async function toggleBlock(date, time, calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ) {
  const t = normTime(time)
  const items = await listWindow(`${addDays(date, -1)}T00:00:00Z`, `${addDays(date, 2)}T00:00:00Z`, calendarId)
  let blockEv = null
  let booked = false
  for (const ev of items) {
    const p = ev.extendedProperties?.private || {}
    if (p.slotDate === date && p.slotTime === t) {
      if (p.type === 'block') blockEv = ev
      else booked = true
    }
  }
  if (booked) return 'booked'
  if (blockEv) {
    await deleteEvent(blockEv.id, calendarId)
    return 'freed'
  }
  await createBlock(date, t, calendarId, tz)
  return 'blocked'
}

export async function blockWholeDay(date, calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ) {
  const items = await listWindow(`${addDays(date, -1)}T00:00:00Z`, `${addDays(date, 2)}T00:00:00Z`, calendarId)
  const taken = new Set()
  for (const ev of items) {
    const p = ev.extendedProperties?.private || {}
    if (p.slotDate === date && p.slotTime) taken.add(p.slotTime)
  }
  const slots = await getSlots(calendarId)
  for (const t of slots) if (!taken.has(t)) await createBlock(date, t, calendarId, tz)
}

export async function unblockWholeDay(date, calendarId = DEFAULT_CAL()) {
  const items = await listWindow(`${addDays(date, -1)}T00:00:00Z`, `${addDays(date, 2)}T00:00:00Z`, calendarId)
  for (const ev of items) {
    const p = ev.extendedProperties?.private || {}
    if (p.type === 'block' && p.slotDate === date) await deleteEvent(ev.id, calendarId)
  }
}

export async function toggleDayOff(date, calendarId = DEFAULT_CAL()) {
  const items = await listWindow(`${addDays(date, -1)}T00:00:00Z`, `${addDays(date, 2)}T00:00:00Z`, calendarId)
  const existing = items.find(
    (ev) =>
      ev.extendedProperties?.private?.type === 'dayoff' &&
      ev.extendedProperties?.private?.dayoff === date
  )
  if (existing) {
    await deleteEvent(existing.id, calendarId)
    return 'removed'
  }
  await getCalendar().events.insert({
    calendarId,
    requestBody: {
      summary: '🌴 Выходной',
      start: { date },
      end: { date: addDays(date, 1) },
      colorId: '8',
      extendedProperties: { private: { type: 'dayoff', dayoff: date } },
    },
  })
  return 'added'
}
