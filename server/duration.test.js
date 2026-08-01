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
