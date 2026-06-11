// Telegram bot integration (multi-tenant, one shared bot).
//
// The bot serves many masters. Each master = a tenant in tenants.js, identified
// by the chat the update arrives in (their personal chat or their group). Every
// action (notify, confirm, /menu, story) is performed against THAT tenant's
// calendar and chat, so masters only ever see their own bookings.

import {
  isCalendarConfigured,
  confirmEvent,
  deleteEvent,
  getEvent,
  getAvailability,
  getDayStatus,
  toggleBlock,
  toggleDayOff,
  blockWholeDay,
  unblockWholeDay,
  addDays,
  TIME_SLOTS,
  WINDOW_DAYS,
  localToday,
} from './google-calendar.js'
import { renderScheduleImage } from './story.js'
import { tenantByChatId, isTenantAdmin } from './tenants.js'

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN

// Pending interactions, keyed by chat id (carry the tenant's calendar/tz)
const awaitingTime = new Map()
const pendingStory = new Map()

export function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN)
}

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!data.ok) console.error('Telegram API error:', method, data.description)
  return data
}

const sendMessage = (chatId, text, extra = {}) =>
  tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra })

const editMessageText = (chatId, messageId, text, extra = {}) =>
  tg('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra })

const editMessageReplyMarkup = (chatId, messageId, reply_markup) =>
  tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup })

const answerCallback = (id, text = '') =>
  tg('answerCallbackQuery', { callback_query_id: id, text })

async function sendPhotoBuffer(chatId, buffer, caption) {
  const form = new FormData()
  form.append('chat_id', String(chatId))
  if (caption) form.append('caption', caption)
  form.append('photo', new Blob([buffer], { type: 'image/png' }), 'schedule.png')
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/sendPhoto`, {
    method: 'POST',
    body: form,
  })
  const data = await res.json()
  if (!data.ok) console.error('sendPhoto error:', data.description)
  return data
}

async function downloadTelegramFile(fileId) {
  const info = await tg('getFile', { file_id: fileId })
  const fp = info.result?.file_path
  if (!fp) throw new Error('getFile failed')
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN()}/${fp}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Registers the single webhook so Telegram delivers all updates here. */
export async function setupWebhook(publicUrl, secret) {
  if (!isTelegramConfigured() || !publicUrl) return
  const url = `${publicUrl.replace(/\/$/, '')}/api/telegram/webhook`
  const data = await tg('setWebhook', {
    url,
    secret_token: secret || undefined,
    allowed_updates: ['message', 'callback_query'],
  })
  if (data.ok) console.log('✅ Telegram webhook set to', url)
  await tg('setMyCommands', {
    commands: [{ command: 'menu', description: 'Управление расписанием' }],
  })
}

// ---- helpers ----------------------------------------------------------------

function fmtWhen(event) {
  const iso = event?.start?.dateTime || event?.start?.date
  if (!iso) return { date: '', time: '' }
  const d = new Date(iso)
  return {
    date: d.toISOString().slice(0, 10),
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  }
}

function messageClientButton(method, contact, text) {
  if (!contact) return null
  const url =
    method === 'telegram'
      ? `https://t.me/${contact.replace(/^@/, '')}`
      : `https://wa.me/${contact.replace(/[^\d]/g, '')}?text=${encodeURIComponent(text)}`
  return { text: '✍️ Message client', url }
}

const confirmationTextForClient = ({ clientName, service, date, time }) =>
  `Hello, ${clientName || ''}! Your appointment is confirmed: ${service || 'booking'}, ${date} at ${time}. If you need to reschedule, just message me. See you! 💛`

function bookingCard(booking) {
  const channel = booking.method === 'telegram' ? '✈️ Telegram' : '🟢 WhatsApp'
  return (
    `🆕 <b>New booking</b>\n\n` +
    `👤 <b>${booking.name}</b>\n` +
    `💅 ${booking.service || '—'}\n` +
    `📅 ${booking.date || '—'}${booking.time ? ' 🕐 ' + booking.time : ''}\n` +
    `${channel}: ${booking.contact}\n` +
    `💬 ${booking.message || '—'}`
  )
}

// ---- public: send a new booking to the right master -------------------------

export async function sendBookingToMaster(booking, event, tenant) {
  if (!tenant?.telegramChatId) return
  const eventId = event?.id || 'none'
  return sendMessage(tenant.telegramChatId, bookingCard(booking), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: `c:${eventId}` },
          { text: '🕐 Reschedule', callback_data: `r:${eventId}` },
        ],
        [{ text: '❌ Decline', callback_data: `d:${eventId}` }],
      ],
    },
  })
}

// ---- update handling --------------------------------------------------------

export async function handleUpdate(update) {
  try {
    if (update.callback_query) return await onCallback(update.callback_query)
    if (update.message) return await onMessage(update.message)
  } catch (err) {
    console.error('handleUpdate error:', err)
  }
}

async function onCallback(cq) {
  const chatId = cq.message?.chat?.id
  const tenant = tenantByChatId(chatId)
  if (!tenant || !isTenantAdmin(tenant, cq.from?.id)) return answerCallback(cq.id)

  const ctx = { chatId, calendarId: tenant.calendarId, tz: tenant.timezone }
  const data = cq.data || ''
  const messageId = cq.message?.message_id

  if (data.includes('|')) return await onMenuCallback(data, cq.id, messageId, ctx)

  const [action, eventId] = data.split(':')
  const hasCal = isCalendarConfigured() && eventId && eventId !== 'none'
  const originalText = cq.message?.text || ''

  if (action === 'd') {
    if (hasCal) await deleteEvent(eventId, ctx.calendarId)
    await editMessageText(chatId, messageId, `${originalText}\n\n❌ <b>Declined</b>`, {
      reply_markup: { inline_keyboard: [] },
    })
    return answerCallback(cq.id, 'Declined')
  }

  if (action === 'r') {
    awaitingTime.set(String(chatId), { eventId, messageId, originalText, ctx })
    await sendMessage(
      chatId,
      '🕐 Send the new time as <b>YYYY-MM-DD HH:MM</b> (or just <b>HH:MM</b> to keep the date).'
    )
    return answerCallback(cq.id, 'Send the new time')
  }

  if (action === 'c') {
    return await finalizeConfirm({ ctx, eventId, messageId, originalText, callbackId: cq.id })
  }

  return answerCallback(cq.id)
}

async function onMessage(msg) {
  const chatId = msg.chat?.id
  const tenant = tenantByChatId(chatId)
  const text = (msg.text || '').trim()
  const cmd = text.split(/[\s@]/)[0]

  // Unknown chat: help onboarding by revealing the chat id
  if (!tenant) {
    if (cmd === '/start' || cmd === '/menu') {
      await sendMessage(
        chatId,
        `👋 Этот чат пока не подключён.\nВаш ID: <code>${chatId}</code>\nПередайте его администратору для подключения.`
      )
    }
    return
  }

  if (!isTenantAdmin(tenant, msg.from?.id)) return
  const ctx = { chatId, calendarId: tenant.calendarId, tz: tenant.timezone }

  // Photo while waiting for a story background → generate the image
  if (msg.photo?.length) {
    const story = pendingStory.get(String(chatId))
    if (story) {
      pendingStory.delete(String(chatId))
      await sendMessage(chatId, '🎨 Генерирую картинку…')
      const fileId = msg.photo[msg.photo.length - 1].file_id
      const bg = await downloadTelegramFile(fileId)
      const buf = await renderScheduleImage({
        lang: story.lang,
        backgroundBuffer: bg,
        calendarId: ctx.calendarId,
        tz: ctx.tz,
      })
      await sendPhotoBuffer(chatId, buf, '📅 Свободные окна на месяц')
    }
    return
  }

  if (cmd === '/start' || cmd === '/menu') return sendMenu(ctx)

  const pending = awaitingTime.get(String(chatId))
  if (!pending) return

  const parsed = parseTime(msg.text || '')
  if (!parsed) {
    return sendMessage(chatId, '⚠️ Could not read the time. Use <b>YYYY-MM-DD HH:MM</b> or <b>HH:MM</b>.')
  }
  awaitingTime.delete(String(chatId))
  let date = parsed.date
  if (!date && isCalendarConfigured() && pending.eventId !== 'none') {
    const ev = await getEvent(pending.eventId, ctx.calendarId)
    date = fmtWhen(ev).date
  }
  return await finalizeConfirm({
    ctx,
    eventId: pending.eventId,
    messageId: pending.messageId,
    originalText: pending.originalText,
    date,
    time: parsed.time,
  })
}

async function finalizeConfirm({ ctx, eventId, messageId, originalText = '', date, time, callbackId }) {
  const hasCal = isCalendarConfigured() && eventId && eventId !== 'none'
  let info = { clientName: '', service: '', method: 'whatsapp', contact: '', date, time }

  if (hasCal) {
    const ev = await confirmEvent(eventId, date ? { date, time } : {}, ctx.calendarId, ctx.tz)
    const when = fmtWhen(ev)
    const priv = ev.extendedProperties?.private || {}
    info = {
      clientName: priv.clientName || '',
      service: priv.service || '',
      method: priv.method || 'whatsapp',
      contact: priv.contact || '',
      date: when.date,
      time: when.time,
    }
  }

  const btn = messageClientButton(info.method, info.contact, confirmationTextForClient(info))
  const summary =
    `✅ <b>Confirmed</b>` +
    (info.date ? ` — ${info.date}${info.time ? ' ' + info.time : ''}` : time ? ` — ${time}` : '')
  const fullText = originalText ? `${originalText}\n\n${summary}` : summary
  const reply_markup = btn ? { inline_keyboard: [[btn]] } : { inline_keyboard: [] }

  if (messageId) await editMessageText(ctx.chatId, messageId, fullText, { reply_markup })
  else await sendMessage(ctx.chatId, fullText, { reply_markup })
  if (callbackId) await answerCallback(callbackId, 'Confirmed')
}

// ===========================================================================
// Scheduling menu (per-tenant via ctx.calendarId)
// ===========================================================================

const menuText = () => '⚙️ <b>Меню мастера</b>\nУправление расписанием:'
const menuKeyboard = () => ({
  inline_keyboard: [
    [{ text: '🚫 Заблокировать / освободить время', callback_data: 'm|block' }],
    [{ text: '🌴 Выходные дни', callback_data: 'm|dayoff' }],
    [{ text: '📋 Расписание (месяц)', callback_data: 'm|list' }],
    [{ text: '🖼 Картинка для сторис', callback_data: 'm|story' }],
  ],
})

async function sendMenu(ctx) {
  if (!isCalendarConfigured()) {
    return sendMessage(ctx.chatId, '⚠️ Google Calendar ещё не подключён.')
  }
  return sendMessage(ctx.chatId, menuText(), { reply_markup: menuKeyboard() })
}

function dayLabel(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' })
}

async function buildDaysKeyboard(mode, calendarId, tz) {
  const today = localToday(tz)
  let off = new Set()
  if (mode === 'dayoff') off = new Set((await getAvailability(WINDOW_DAYS, calendarId, tz)).daysOff)
  const rows = []
  let row = []
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const date = addDays(today, i)
    const prefix = mode === 'dayoff' && off.has(date) ? '🌴 ' : ''
    const cb = mode === 'dayoff' ? `do|${date}` : `bd|${date}`
    row.push({ text: prefix + dayLabel(date), callback_data: cb })
    if (row.length === 2) {
      rows.push(row)
      row = []
    }
  }
  if (row.length) rows.push(row)
  rows.push([{ text: '⬅️ Меню', callback_data: 'm|home' }])
  return { inline_keyboard: rows }
}

function buildSlotsKeyboard(date, status) {
  const rows = []
  let row = []
  for (const t of TIME_SLOTS) {
    const st = status[t]
    const icon = st === 'booked' ? '📅' : st === 'blocked' ? '🚫' : '🟢'
    row.push({ text: `${icon} ${t}`, callback_data: `bt|${date}|${t}` })
    if (row.length === 3) {
      rows.push(row)
      row = []
    }
  }
  if (row.length) rows.push(row)
  rows.push([
    { text: '🚫 Весь день', callback_data: `ba|${date}` },
    { text: '🟢 Очистить день', callback_data: `bc|${date}` },
  ])
  rows.push([{ text: '⬅️ К дням', callback_data: 'm|block' }])
  return { inline_keyboard: rows }
}

async function scheduleSummary(calendarId, tz) {
  const av = await getAvailability(WINDOW_DAYS, calendarId, tz)
  const lines = ['📋 <b>Расписание на месяц</b>', '']
  if (av.daysOff.length) lines.push('🌴 Выходные: ' + av.daysOff.sort().map(dayLabel).join(', '))
  const byDate = {}
  for (const s of av.busy) {
    const [d, t] = s.split(' ')
    ;(byDate[d] = byDate[d] || []).push(t)
  }
  const dates = Object.keys(byDate).sort()
  if (dates.length) {
    lines.push('', '⏰ Занятые слоты:')
    for (const d of dates) lines.push(`• ${dayLabel(d)}: ${byDate[d].sort().join(', ')}`)
  }
  if (!av.daysOff.length && !dates.length) lines.push('Всё свободно ✨')
  return lines.join('\n')
}

async function onMenuCallback(data, callbackId, messageId, ctx) {
  if (!isCalendarConfigured()) return answerCallback(callbackId, 'Календарь не подключён')
  const parts = data.split('|')
  const action = parts[0]
  const cid = ctx.calendarId
  const chatId = ctx.chatId

  if (action === 'm') {
    const sub = parts[1]
    if (sub === 'home') {
      await editMessageText(chatId, messageId, menuText(), { reply_markup: menuKeyboard() })
    } else if (sub === 'block') {
      await editMessageText(chatId, messageId, '🚫 <b>Блокировка времени</b>\nВыбери день:', {
        reply_markup: await buildDaysKeyboard('block', cid, ctx.tz),
      })
    } else if (sub === 'dayoff') {
      await editMessageText(chatId, messageId, '🌴 <b>Выходные</b>\nНажми на день, чтобы переключить:', {
        reply_markup: await buildDaysKeyboard('dayoff', cid, ctx.tz),
      })
    } else if (sub === 'list') {
      await editMessageText(chatId, messageId, await scheduleSummary(cid, ctx.tz), {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🖼 Картинка для сторис', callback_data: 'm|story' }],
            [{ text: '⬅️ Меню', callback_data: 'm|home' }],
          ],
        },
      })
    } else if (sub === 'story') {
      await editMessageText(chatId, messageId, '🖼 <b>Картинка для сторис</b>\nЯзык месяца:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'English', callback_data: 'sl|en' }],
            [{ text: 'Deutsch', callback_data: 'sl|de' }],
            [{ text: 'Eesti', callback_data: 'sl|et' }],
            [{ text: '⬅️ Меню', callback_data: 'm|home' }],
          ],
        },
      })
    }
    return answerCallback(callbackId)
  }

  if (action === 'sl') {
    const lang = parts[1]
    await editMessageText(chatId, messageId, '🖼 Фон картинки:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎨 Фон сайта', callback_data: `sg|${lang}|brand` }],
          [{ text: '📷 Своё фото', callback_data: `sg|${lang}|photo` }],
          [{ text: '⬅️ Назад', callback_data: 'm|story' }],
        ],
      },
    })
    return answerCallback(callbackId)
  }

  if (action === 'sg') {
    const [, lang, bg] = parts
    if (bg === 'photo') {
      pendingStory.set(String(chatId), { lang })
      await sendMessage(chatId, '📷 Пришли фото — оно станет фоном, времена добавлю поверх.')
      return answerCallback(callbackId)
    }
    await answerCallback(callbackId, 'Генерирую…')
    const buf = await renderScheduleImage({ lang, calendarId: cid, tz: ctx.tz })
    await sendPhotoBuffer(chatId, buf, '📅 Свободные окна на месяц')
    return
  }

  if (action === 'bd') {
    const date = parts[1]
    const { dayoff, status } = await getDayStatus(date, cid)
    await editMessageText(
      chatId,
      messageId,
      `🚫 <b>${dayLabel(date)}</b>\n${dayoff ? '🌴 Выходной день\n' : ''}Нажми на слот, чтобы заблокировать / освободить:`,
      { reply_markup: buildSlotsKeyboard(date, status) }
    )
    return answerCallback(callbackId)
  }

  if (action === 'bt') {
    const [, date, time] = parts
    const result = await toggleBlock(date, time, cid, ctx.tz)
    if (result === 'booked') return answerCallback(callbackId, '📅 Этот слот занят записью клиента')
    const { status } = await getDayStatus(date, cid)
    await editMessageReplyMarkup(chatId, messageId, buildSlotsKeyboard(date, status))
    return answerCallback(callbackId, result === 'blocked' ? '🚫 Заблокировано' : '🟢 Освобождено')
  }

  if (action === 'ba' || action === 'bc') {
    const date = parts[1]
    if (action === 'ba') await blockWholeDay(date, cid, ctx.tz)
    else await unblockWholeDay(date, cid)
    const { status } = await getDayStatus(date, cid)
    await editMessageReplyMarkup(chatId, messageId, buildSlotsKeyboard(date, status))
    return answerCallback(callbackId, action === 'ba' ? '🚫 День заблокирован' : '🟢 День освобождён')
  }

  if (action === 'do') {
    const date = parts[1]
    const result = await toggleDayOff(date, cid)
    await editMessageReplyMarkup(chatId, messageId, await buildDaysKeyboard('dayoff', cid, ctx.tz))
    return answerCallback(callbackId, result === 'added' ? '🌴 Выходной добавлен' : '✅ Выходной снят')
  }

  return answerCallback(callbackId)
}

function parseTime(input) {
  const s = input.trim()
  let m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})$/)
  if (m) return { date: m[1], time: pad(m[2]) }
  m = s.match(/^(\d{1,2}:\d{2})$/)
  if (m) return { date: '', time: pad(m[1]) }
  return null
}

const pad = (hhmm) => {
  const [h, m] = hhmm.split(':')
  return `${h.padStart(2, '0')}:${m}`
}
