// Generates an Instagram-story image (1080×1920) of the free booking slots
// for the next two weeks. Background is either the site's palette or a photo
// the master sends; the free times are drawn on top automatically.

import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas'
import path from 'path'
import { fileURLToPath } from 'url'
import { getAvailability, addDays, TIME_SLOTS } from './google-calendar.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
GlobalFonts.registerFromPath(path.join(__dirname, 'assets', 'PlayfairDisplay.ttf'), 'Playfair')
GlobalFonts.registerFromPath(path.join(__dirname, 'assets', 'Cormorant.ttf'), 'Cormorant')

export const STORY_LANGS = {
  en: 'en-US',
  de: 'de-DE',
  et: 'et-EE',
}

function monthName(dateStr, lang) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const n = d.toLocaleString(STORY_LANGS[lang] || 'en-US', {
    month: 'long',
    timeZone: 'UTC',
  })
  return n.charAt(0).toUpperCase() + n.slice(1)
}

/** Free slots per day for the next `days` days (skips days with none). */
export async function computeFreeDays(days = 14, calendarId) {
  const { busy, daysOff } = await getAvailability(days, calendarId)
  const busySet = new Set(busy)
  const offSet = new Set(daysOff)
  const today = new Date().toISOString().slice(0, 10)
  const out = []
  for (let i = 0; i < days; i++) {
    const date = addDays(today, i)
    if (offSet.has(date)) continue
    const free = TIME_SLOTS.filter((t) => !busySet.has(`${date} ${t}`))
    if (free.length) out.push({ date, free })
  }
  return out
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

export async function renderScheduleImage({ lang = 'en', backgroundBuffer = null, calendarId } = {}) {
  const W = 1080
  const H = 1920
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')

  // --- Background ---
  if (backgroundBuffer) {
    const img = await loadImage(backgroundBuffer)
    const scale = Math.max(W / img.width, H / img.height)
    const w = img.width * scale
    const h = img.height * scale
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h)
    // Soft veil so text stays readable over any photo
    ctx.fillStyle = 'rgba(243,236,226,0.35)'
    ctx.fillRect(0, 0, W, H)
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H)
    g.addColorStop(0, '#F7F1E8')
    g.addColorStop(0.55, '#F1E7D9')
    g.addColorStop(1, '#E7D8C4')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
  }

  const days = await computeFreeDays(14, calendarId)
  const titleDate = days[0]?.date || new Date().toISOString().slice(0, 10)

  // --- Title (month) ---
  ctx.textAlign = 'center'
  ctx.fillStyle = '#2A2420'
  ctx.font = '700 150px Playfair'
  ctx.fillText(monthName(titleDate, lang), W / 2, 220)

  // --- Lines: keep a big readable font; wrap long time lists instead of shrinking ---
  const panelX = 56
  const panelW = W - 112
  const padX = 56
  const padY = 54
  const innerW = panelW - padX * 2
  const panelY = 300
  const maxPanelH = H - panelY - 80
  const maxContentH = maxPanelH - padY * 2

  // Pick the largest font (from this list) at which the wrapped content fits
  const candidates = [52, 48, 44, 40, 36]
  let chosen = null
  for (const size of candidates) {
    ctx.font = `600 ${size}px Cormorant`
    const lineH = Math.round(size * 1.34)
    const dayGap = Math.round(size * 0.5)
    const blocks = days.map((d) => wrapDay(ctx, d, innerW))
    const totalLines = blocks.reduce((n, b) => n + b.length, 0)
    const height = totalLines * lineH + Math.max(0, blocks.length - 1) * dayGap
    chosen = { size, lineH, dayGap, blocks, height }
    if (height <= maxContentH) break
  }

  // --- Panel sized to content ---
  const panelH = Math.min(chosen.height + padY * 2, maxPanelH)
  ctx.fillStyle = 'rgba(251,246,239,0.9)'
  roundRect(ctx, panelX, panelY, panelW, panelH, 34)
  ctx.fill()

  // --- Draw, day by day (with wrapping) ---
  ctx.textAlign = 'left'
  ctx.fillStyle = '#2A2420'
  ctx.font = `600 ${chosen.size}px Cormorant`
  let y = panelY + padY + chosen.size
  for (const block of chosen.blocks) {
    for (const line of block) {
      if (y > panelY + panelH - 12) break
      ctx.fillText(line, panelX + padX, y)
      y += chosen.lineH
    }
    y += chosen.dayGap
  }

  return await canvas.encode('png')
}

// Wrap one day's free times under its date when they exceed the line width
function wrapDay(ctx, d, innerW) {
  const [, mm, dd] = d.date.split('-')
  const head = `${dd}.${mm} —`
  const indent = '      '
  const lines = []
  let line = head
  for (const t of d.free) {
    const test = `${line}   ${t}`
    if (ctx.measureText(test).width > innerW && line !== head) {
      lines.push(line)
      line = `${indent}${t}`
    } else {
      line = test
    }
  }
  lines.push(line)
  return lines
}
