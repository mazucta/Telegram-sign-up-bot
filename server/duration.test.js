// Per-procedure durations: node server/duration.test.js
import assert from 'node:assert/strict'
import { serviceMinutes, marks, DEFAULT_MINUTES } from './google-calendar.js'

// Durations read straight off the site's service labels (ru / en / et)
assert.equal(serviceMinutes('Стрижка · 60 мин · 30-45 €'), 60)
assert.equal(serviceMinutes('Стрижка чёлки · 15 мин'), 15)
assert.equal(serviceMinutes('Окрашивание один тон (длинные волосы) · 3 ч · 75-85 €'), 180)
assert.equal(serviceMinutes('Air Touch · 4-5 ч · 200-300 €'), 300) // range → upper bound
assert.equal(serviceMinutes('Balayage · 3 h · 150-250 €'), 180)
assert.equal(serviceMinutes('Fringe trim · 15 min'), 15)
assert.equal(serviceMinutes('Triibutamine (kogu pikkus) · 4 t'), 240)
assert.equal(serviceMinutes('балаяж 3ч'), 180) // master typing it by hand

// No duration in the text → the old 2 h default; prices never read as minutes
assert.equal(serviceMinutes('Другое'), DEFAULT_MINUTES)
assert.equal(serviceMinutes('Укладка · 25-30 €'), DEFAULT_MINUTES)
assert.equal(serviceMinutes(''), DEFAULT_MINUTES)
assert.equal(serviceMinutes(undefined), DEFAULT_MINUTES)

// A long appointment occupies every slot it spans, and nothing after it
const airTouch = marks('10:00', 300)
assert.ok(['10:00', '12:00', '14:00', '14:45'].every((t) => airTouch.includes(t)))
assert.ok(!airTouch.includes('15:00'))

const hour = marks('14:00', 60)
assert.deepEqual(hour, ['14:00', '14:00', '14:15', '14:30', '14:45'])
assert.ok(!hour.includes('15:00'))

// Half-hour and off-grid starts still cover the slots they overlap
assert.ok(marks('09:30', 60).includes('10:00'))
assert.ok(marks('9:20', 60).includes('09:20')) // exact start kept for curated times
assert.ok(marks('09:20', 60).includes('10:00'))

// Never spills past midnight
assert.ok(marks('23:00', 300).every((t) => t < '24:00'))

console.log('✅ durations ok')

// --- the master's own calendar events occupy the chair too --------------------
const { busySpan } = await import('./google-calendar.js')
const TZ = 'Europe/Tallinn' // UTC+3 in August

// A hand-made event is read in the studio timezone, not the server's UTC
const dentist = {
  start: { dateTime: '2026-08-10T11:00:00Z' },
  end: { dateTime: '2026-08-10T12:30:00Z' },
}
assert.deepEqual(busySpan(dentist, TZ), { date: '2026-08-10', time: '14:00', mins: 90, own: false })
assert.ok(marks('14:00', 90).includes('15:00')) // 14:00-15:30 also takes the 15:00 slot

// Our own bookings keep using their stored slot, whatever the server timezone
const booking = {
  start: { dateTime: '2026-08-10T14:00:00+03:00' },
  end: { dateTime: '2026-08-10T15:00:00+03:00' },
  extendedProperties: { private: { slotDate: '2026-08-10', slotTime: '14:00' } },
}
assert.equal(busySpan(booking, TZ).own, true)
assert.equal(busySpan(booking, TZ).time, '14:00')

// "Free" events, all-day events and the config marker never block a slot
assert.equal(busySpan({ ...dentist, transparency: 'transparent' }, TZ), null)
assert.equal(busySpan({ start: { date: '2026-08-10' } }, TZ), null)
assert.equal(busySpan({ ...dentist, extendedProperties: { private: { type: 'slotsconfig' } } }, TZ), null)

console.log('✅ calendar events ok')
