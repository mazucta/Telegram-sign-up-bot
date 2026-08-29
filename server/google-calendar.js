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
export const SLOT_HOURS = 2
export const DEFAULT_MINUTES = SLOT_HOURS * 60

// How long a procedure takes. The site's service labels already carry it
// ("Стрижка · 60 мин · 30-45 €", "Air Touch · 4-5 ч", "Balayage · 3 h", "3 t"),
// and the master can type it when adding a booking by hand ("Аня, балаяж 3ч").
// A range takes the upper bound (never under-block the chair); no match → 2 h.
const DURATION_RE = /(\d+)\s*(?:[-–—]\s*(\d+)\s*)?(мин|min|ч|hour|tund|h|t)(?![a-zа-яё])/i
export function serviceMinutes(service) {
  const m = DURATION_RE.exec(String(service || ''))
  if (!m) return DEFAULT_MINUTES
  const n = Number(m[2] || m[1])
  if (!n) return DEFAULT_MINUTES
  return /^(мин|min)/i.test(m[3]) ? n : n * 60
}

// Actual length of an existing event — so a reschedule keeps the procedure's
// duration, and a booking the master dragged longer in Google Calendar counts
// at its real length. Falls back to 2 h (events created before durations).
export function eventMinutes(ev) {
  const s = ev?.start?.dateTime
  const e = ev?.end?.dateTime
  if (!s || !e) return DEFAULT_MINUTES
  return Math.max(15, Math.round((new Date(e) - new Date(s)) / 60e3)) || DEFAULT_MINUTES
}

// How far ahead bookings are offered (site availability, bot menu, story).
export const WINDOW_DAYS = 30

// Busy/day-off scan horizon for curated filtering: masters set curated dates
// months ahead, so taken slots must be detected past the 30-day UI window.
// ponytail: capped by listWindow's maxResults=250; raise both if a calendar outgrows it.
export const SCAN_DAYS = 92

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
const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
const toMinutes = (t) => {
  const [h, m] = normTime(t).split(':').map(Number)
  return h * 60 + m
}
const addMinutes = (t, mins) => hhmm(Math.min(toMinutes(t) + mins, 23 * 60 + 59))

// An event the master added by hand carries only an ISO timestamp. The server
// runs in UTC, so the slot it occupies has to be read in the studio timezone.
function localParts(iso, tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso))
  const get = (t) => parts.find((p) => p.type === t)?.value
  const hour = get('hour') === '24' ? '00' : get('hour') // some runtimes emit 24 at midnight
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` }
}

// When (and for how long) an event takes the chair. Covers our own bookings and
// blocks — they carry slotDate/slotTime — plus anything the master put in the
// calendar herself: a dentist appointment blocks the site just as a booking does.
// Events set to "Free" in Google are deliberately ignored, that is the standard
// way to keep a reminder from occupying time.
// ponytail: an event running past midnight only blocks up to 24:00; split it if
// a master ever works night shifts.
export function busySpan(ev, tz = DEFAULT_TZ) {
  if (ev.transparency === 'transparent' || ev.status === 'cancelled') return null
  const p = ev.extendedProperties?.private || {}
  if (p.type === 'slotsconfig' || p.type === 'dayoff' || p.type === 'curated') return null
  if (p.slotDate && p.slotTime) return { date: p.slotDate, time: p.slotTime, mins: eventMinutes(ev), own: true }
  if (!ev.start?.dateTime) return null // all-day events are handled as days off
  // Length is not a hint: a 10 h entry is as busy as a 1 h one. A "working day
  // 10:00-20:00" marker must be set to "Free"/«Свободен» in Google — that is the
  // standard flag for "this event does not occupy me", and it is honoured above.
  const { date, time } = localParts(ev.start.dateTime, tz)
  return { date, time, mins: eventMinutes(ev), own: false }
}

// Days an all-day event covers (Google's end.date is exclusive), so a holiday
// spanning a week closes the whole week.
// ponytail: capped at a year; longer absences aren't a booking-window problem.
export function allDayDates(ev) {
  const start = ev?.start?.date
  if (!start || ev.start.dateTime) return []
  const end = ev.end?.date > start ? ev.end.date : addDays(start, 1)
  const out = []
  for (let d = start; d < end && out.length < 366; d = addDays(d, 1)) out.push(d)
  return out
}

// Every quarter-hour mark an appointment occupies, so a 4 h Air Touch marks the
// whole afternoon busy — not just its start time. The exact start is included
// even when it is off-grid (curated times are matched by exact string).
// ponytail: 15-min grid; drop GRID to 5 if a master ever offers times off it.
const GRID = 15
export function marks(time, mins = DEFAULT_MINUTES) {
  const start = toMinutes(time)
  const end = Math.min(start + Math.max(mins, 1), 24 * 60)
  const out = [normTime(time)]
  for (let x = Math.floor(start / GRID) * GRID; x < end; x += GRID) out.push(hhmm(x))
  return out
}
export const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function slot(date, time, tz, mins = DEFAULT_MINUTES) {
  const t = /^\d{1,2}:\d{2}$/.test(time || '') ? normTime(time) : '11:00'
  return {
    date,
    time: t,
    mins,
    start: { dateTime: `${date}T${t}:00`, timeZone: tz },
    end: { dateTime: `${date}T${addMinutes(t, mins)}:00`, timeZone: tz },
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
    timeMax: toISO || undefined, // no upper bound: all upcoming
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  })
  return res.data.items || []
}

// ---- bookings ---------------------------------------------------------------

export async function createPendingEvent(booking, calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ) {
  const s = slot(booking.date, booking.time, tz, serviceMinutes(booking.service))
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
    // Rescheduling keeps the procedure's length (2 h only for legacy events)
    const s = slot(date, time || '11:00', tz, eventMinutes(ev))
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

// Merge keys into an event's private extendedProperties (clientChatId,
// reminded, reviewAsked, …) without touching the rest.
export async function setPrivateProps(eventId, props, calendarId = DEFAULT_CAL()) {
  const ev = await getEvent(eventId, calendarId)
  const priv = { ...(ev.extendedProperties?.private || {}), ...props }
  await getCalendar().events.patch({
    calendarId,
    eventId,
    requestBody: { extendedProperties: { private: priv } },
  })
}

// Remember the client's Telegram chat so the bot can push updates (cancel /
// reschedule / confirm) about this booking. Set when the client taps the
// "get notifications" deep link after booking on the site.
export const setClientChat = (eventId, chatId, calendarId = DEFAULT_CAL()) =>
  setPrivateProps(eventId, { clientChatId: String(chatId) }, calendarId)

// A client's own upcoming bookings across one master's calendar, matched by
// the Telegram chat they subscribed with.
export async function getClientBookings(chatId, calendarId = DEFAULT_CAL()) {
  if (!isCalendarConfigured() || !calendarId) return []
  const res = await getCalendar().events.list({
    calendarId,
    privateExtendedProperty: `clientChatId=${chatId}`,
    timeMin: new Date().toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 20,
  })
  return (res.data.items || []).map((ev) => {
    const p = ev.extendedProperties?.private || {}
    return {
      id: ev.id,
      status: p.status || 'confirmed',
      service: p.service || '',
      date: p.slotDate || (ev.start?.dateTime || '').slice(0, 10),
      time: p.slotTime || '',
    }
  })
}

// ALL active client bookings (pending + confirmed) from 6h ago onward, however
// far in the future — a booking the menu can't list is one the master can't
// cancel. Blocks and days-off are excluded — this is only real client records.
export async function listBookings(calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ) {
  if (!isCalendarConfigured() || !calendarId) return []
  const now = Date.now()
  const items = await listWindow(new Date(now - 6 * 3600e3).toISOString(), null, calendarId)
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
      clientChatId: p.clientChatId || '',
      reminded: p.reminded === '1',
      reviewAsked: p.reviewAsked === '1',
      date: p.slotDate || (ev.start?.dateTime || '').slice(0, 10),
      time: p.slotTime || '',
      startISO: ev.start?.dateTime || '',
      endISO: ev.end?.dateTime || '',
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

// `fallback` is the master's own default (tenant.slots) for when they haven't
// set times from the bot; TIME_SLOTS only when they have neither.
export async function getSlots(calendarId = DEFAULT_CAL(), fallback = TIME_SLOTS) {
  const base = fallback?.length ? fallback : TIME_SLOTS
  if (!isCalendarConfigured() || !calendarId) return base
  try {
    const ev = await findSlotsConfig(calendarId)
    const list = (ev?.extendedProperties?.private?.slots || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return list.length ? list : base
  } catch {
    return base
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
  const horizon = addDays(today, 366) // typo'd years like "22.08.28" → 2028 get dropped
  for (const e of entries || []) {
    if (!e?.date || e.date < today || e.date > horizon) continue
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
  const horizon = addDays(today, 366) // hides stale typo'd years (e.g. 2028) saved before the write-guard
  return (source || [])
    .map((s) => ({
      date: s.date,
      times: (s.times || []).filter(
        (t) => !busySet.has(`${s.date} ${t}`) && !(s.date === today && parseInt(t, 10) <= hour)
      ),
    }))
    .filter((s) => s.date >= today && s.date <= horizon && !offSet.has(s.date))
}

// ---- availability (blocks, days off, busy slots) ----------------------------

export async function getAvailability(days = WINDOW_DAYS, calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ, fallback = TIME_SLOTS) {
  if (!isCalendarConfigured() || !calendarId) return { busy: [], daysOff: [], slots: fallback }
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
      for (const d of allDayDates(ev)) daysOff.add(d)
      continue
    }
    // Every busy event blocks its whole length, not just its start slot
    const span = busySpan(ev, tz)
    if (span) for (const t of marks(span.time, span.mins)) busy.add(`${span.date} ${t}`)
  }
  // Today's already-started slots can't be booked (studio-timezone "now")
  const slots = await getSlots(calendarId, fallback)
  const { date: today, hour } = nowInTz(tz)
  for (const t of slots) {
    if (parseInt(t, 10) <= hour) busy.add(`${today} ${t}`)
  }
  return { busy: [...busy], daysOff: [...daysOff], slots }
}

// Why a tenant's calendar isn't working, without digging through deploy logs:
// the exact Google error plus the service-account address the master has to
// share their calendar with. Nothing secret — the key stays in env.
// What is actually occupying a master's calendar, for when "everything is busy"
// needs an explanation. Times and length only — event titles are the master's
// private business and this endpoint is public.
export async function listBusy(calendarId, tz = DEFAULT_TZ, days = 14) {
  const now = Date.now()
  const items = await listWindow(new Date(now).toISOString(), new Date(now + days * 864e5).toISOString(), calendarId)
  return items.map((ev) => {
    const span = busySpan(ev, tz)
    return {
      allDay: Boolean(ev.start?.date && !ev.start?.dateTime),
      free: ev.transparency === 'transparent',
      recurring: Boolean(ev.recurringEventId),
      own: span?.own ?? null,
      at: span ? `${span.date} ${span.time}` : ev.start?.date || '',
      raw: ev.start?.dateTime || '', // what Google actually stored, offset included
      mins: span?.mins ?? 0,
    }
  })
}

export async function calendarDiag(calendarId) {
  const serviceAccount = process.env.GOOGLE_CLIENT_EMAIL || ''
  if (!isCalendarConfigured()) return { ok: false, reason: 'no_credentials' }
  if (!calendarId) return { ok: false, reason: 'no_calendar_id', serviceAccount }
  try {
    const res = await getCalendar().events.list({ calendarId, maxResults: 1, timeMin: new Date().toISOString() })
    // The calendar's own timezone: if it differs from the tenant's, every event
    // the master types in her calendar is read (and shown) an hour off.
    return { ok: true, calendarId, serviceAccount, calendarTimezone: res.data.timeZone || '' }
  } catch (err) {
    // Every calendar the bot CAN see: if the master shared a different one (or
    // a typo'd id), it shows up here and the fix is obvious.
    const visible = await getCalendar()
      .calendarList.list({ maxResults: 50 })
      .then((r) => (r.data.items || []).map((c) => c.id))
      .catch(() => [])
    return { ok: false, calendarId, serviceAccount, code: err.code || 0, message: err.message, visible }
  }
}

export async function getDayStatus(date, calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ) {
  const items = await listWindow(`${addDays(date, -1)}T00:00:00Z`, `${addDays(date, 2)}T00:00:00Z`, calendarId)
  let dayoff = false
  const status = {}
  for (const ev of items) {
    const p = ev.extendedProperties?.private || {}
    if ((p.type === 'dayoff' && p.dayoff === date) || allDayDates(ev).includes(date)) dayoff = true
    const span = busySpan(ev, tz)
    if (span?.date !== date) continue
    // The master's own calendar entries read as taken, same as a client booking
    for (const t of marks(span.time, span.mins)) status[t] = p.type === 'block' ? 'blocked' : 'booked'
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
    const span = busySpan(ev, tz)
    if (span?.date !== date) continue
    if (p.type === 'block') {
      if (span.time === t) blockEv = ev
    } else if (marks(span.time, span.mins).includes(t)) {
      booked = true // covered by an appointment or the master's own event
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

export async function blockWholeDay(date, calendarId = DEFAULT_CAL(), tz = DEFAULT_TZ, fallback = TIME_SLOTS) {
  const items = await listWindow(`${addDays(date, -1)}T00:00:00Z`, `${addDays(date, 2)}T00:00:00Z`, calendarId)
  const taken = new Set()
  for (const ev of items) {
    const span = busySpan(ev, tz)
    if (span?.date === date) for (const t of marks(span.time, span.mins)) taken.add(t)
  }
  const slots = await getSlots(calendarId, fallback)
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
