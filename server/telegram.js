// Telegram bot integration (multi-tenant, one shared bot).
//
// The bot serves many masters. Each master = a tenant in tenants.js, identified
// by the chat the update arrives in (their personal chat or their group). Every
// action (notify, confirm, /menu, story) is performed against THAT tenant's
// calendar and chat, so masters only ever see their own bookings.

import {
  isCalendarConfigured,
  confirmEvent,
  createPendingEvent,
  deleteEvent,
  getClientBookings,
  getEvent,
  listBookings,
  nowInTz,
  setPrivateProps,
  SLOT_HOURS,
  getAvailability,
  getDayStatus,
  toggleBlock,
  toggleDayOff,
  blockWholeDay,
  unblockWholeDay,
  getSlots,
  setSlots,
  getCurated,
  saveCurated,
  setClientChat,
  toggleCuratedTime,
  filterCurated,
  addDays,
  TIME_SLOTS,
  WINDOW_DAYS,
  SCAN_DAYS,
  localToday,
} from './google-calendar.js'
import { renderScheduleImage } from './story.js'
import { TENANTS, getTenant, tenantByChatId, isTenantAdmin, isSuperAdmin } from './tenants.js'

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN

// Pending interactions, keyed by chat id (carry the tenant's calendar/tz)
const awaitingTime = new Map()
const pendingStory = new Map()
const awaitingSlots = new Map()
const awaitingMonth = new Map()
// ponytail: in-memory rebook offers (client chat id → cancelled booking data);
// lost on restart — the client just books on the site instead.
const rebookCtx = new Map()
const awaitingNew = new Map()
// ponytail: superadmin's picked tenant per chat, in-memory — after a restart
// just run /admin again.
const adminTenant = new Map()

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

// Push to a subscribed client; never let it break the master's flow
// (client may have blocked the bot, network may hiccup).
const notifyClient = (chatId, text, extra = {}) => {
  if (chatId) sendMessage(chatId, text, extra).catch((err) => console.error('notifyClient failed:', err))
}

// Client-facing date label (clients get English texts)
const dayLabelEn = (dateStr) =>
  new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

// "Add to calendar" link for the client's confirmation push
function gcalLink({ service, date, time }, tz) {
  if (!date || !time) return ''
  const [h, m] = time.split(':').map(Number)
  const fmt = (hh, mm) => `${date.replace(/-/g, '')}T${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}00`
  return (
    `https://calendar.google.com/calendar/render?action=TEMPLATE` +
    `&text=${encodeURIComponent(service || 'Beauty appointment')}` +
    `&dates=${fmt(h, m)}/${fmt(Math.min(h + SLOT_HOURS, 23), m)}` +
    `&ctz=${encodeURIComponent(tz || 'Europe/Berlin')}`
  )
}

// Bot username for the client deep link (t.me/<bot>?start=…), cached after getMe.
let botUsername = ''
export async function getBotUsername() {
  if (!botUsername && isTelegramConfigured()) {
    botUsername = (await tg('getMe', {})).result?.username || ''
  }
  return botUsername
}

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

// Slot of an event, studio-timezone exact: our events carry slotDate/slotTime in
// extendedProperties; parsing start.dateTime with getHours() would give the
// SERVER's timezone (UTC on Render) and show clients a shifted time.
function fmtWhen(event) {
  const p = event?.extendedProperties?.private || {}
  if (p.slotDate && p.slotTime) return { date: p.slotDate, time: p.slotTime }
  const iso = event?.start?.dateTime || event?.start?.date
  if (!iso) return { date: '', time: '' }
  return { date: iso.slice(0, 10), time: iso.length > 10 ? iso.slice(11, 16) : '' }
}

function messageClientButton(method, contact, text) {
  if (!contact) return null
  let url
  if (method === 'telegram') {
    url = `https://t.me/${contact.replace(/^@/, '')}`
  } else if (method === 'instagram') {
    url = `https://instagram.com/${contact.replace(/^@/, '')}`
  } else {
    url = `https://wa.me/${contact.replace(/[^\d]/g, '')}?text=${encodeURIComponent(text)}`
  }
  return { text: '✍️ Message client', url }
}

const confirmationTextForClient = ({ clientName, service, date, time }) =>
  `Hello, ${clientName || ''}! Your appointment is confirmed: ${service || 'booking'}, ${date} at ${time}. If you need to reschedule, just message me. See you! 💛`

function bookingCard(booking) {
  const channel =
    booking.method === 'telegram'
      ? '✈️ Telegram'
      : booking.method === 'instagram'
        ? '📷 Instagram'
        : '🟢 WhatsApp'
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
    // Never fail silently: stop the button spinner / tell the chat it didn't work.
    const cq = update.callback_query
    if (cq) await answerCallback(cq.id, '⚠️ Ошибка · Error — try again').catch(() => {})
    else if (update.message?.chat?.id) {
      await sendMessage(update.message.chat.id, '⚠️ Не получилось выполнить действие. Попробуй ещё раз.').catch(() => {})
    }
  }
}

async function onCallback(cq) {
  const chatId = cq.message?.chat?.id

  // Client-side buttons (rebook offers) arrive from non-tenant chats
  if ((cq.data || '').startsWith('cl|')) return await onClientRebook(cq)

  // Superadmin picked a master in the /admin panel → drive that tenant from here
  if ((cq.data || '').startsWith('adm|') && isSuperAdmin(cq.from?.id)) {
    const t = getTenant(cq.data.split('|')[1])
    if (!t) return answerCallback(cq.id)
    adminTenant.set(String(chatId), t.id)
    await editMessageText(chatId, cq.message?.message_id, menuText(t), { reply_markup: menuKeyboard() })
    return answerCallback(cq.id, t.name)
  }

  let tenant = tenantByChatId(chatId)
  if (isSuperAdmin(cq.from?.id)) tenant = getTenant(adminTenant.get(String(chatId))) || tenant
  if (!tenant || !isTenantAdmin(tenant, cq.from?.id)) return answerCallback(cq.id)

  const ctx = { chatId, tenant, calendarId: tenant.calendarId, tz: tenant.timezone, availability: tenant.availability || [] }
  const data = cq.data || ''
  const messageId = cq.message?.message_id

  if (data.includes('|')) return await onMenuCallback(data, cq.id, messageId, ctx)

  const [action, eventId] = data.split(':')
  const hasCal = isCalendarConfigured() && eventId && eventId !== 'none'
  const originalText = cq.message?.text || ''

  if (action === 'd') {
    if (hasCal) {
      const p = (await getEvent(eventId, ctx.calendarId).catch(() => null))?.extendedProperties?.private
      // Delete first — the client must only hear "cancelled" once it's true.
      await deleteEvent(eventId, ctx.calendarId).catch((err) => {
        if (err?.code !== 404 && err?.code !== 410) throw err // already gone is fine
      })
      if (p?.clientChatId) {
        const info = {
          clientChatId: p.clientChatId,
          clientName: p.clientName,
          method: p.method,
          contact: p.contact,
          service: p.service,
          date: p.slotDate,
          time: p.slotTime,
        }
        const kb = await rebookKeyboard(ctx.tenant, info)
        notifyClient(
          p.clientChatId,
          cancelTextForClient(info) + (kb ? '\n\nOr pick a new time right here:' : ''),
          kb ? { reply_markup: kb } : {}
        )
      }
    }
    await editMessageText(chatId, messageId, `${originalText}\n\n❌ <b>Declined</b>`, {
      reply_markup: { inline_keyboard: [] },
    })
    return answerCallback(cq.id, 'Declined')
  }

  if (action === 'r') {
    // The reschedule prompt supersedes any pending "send me times" prompt —
    // otherwise the master's reply would be swallowed as a slots/month list.
    awaitingSlots.delete(String(chatId))
    awaitingMonth.delete(String(chatId))
    awaitingNew.delete(String(chatId))
    awaitingTime.set(String(chatId), { eventId, messageId, originalText, ctx })
    await sendMessage(
      chatId,
      '🕐 Пришли новое время как <b>ДД/ММ/ГГГГ ЧЧ:ММ</b> (или просто <b>ЧЧ:ММ</b>, чтобы оставить дату).'
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
  const text = (msg.text || '').trim()
  const cmd = text.split(/[\s@]/)[0]

  // Superadmin panel: pick which master this chat's menu drives
  if (cmd === '/admin' && isSuperAdmin(msg.from?.id)) {
    return sendMessage(chatId, '👑 <b>Админ-панель</b>\nВыбери мастера — меню и записи будут его. Сменить мастера: снова /admin.', {
      reply_markup: { inline_keyboard: TENANTS.map((t) => [{ text: t.name, callback_data: `adm|${t.id}` }]) },
    })
  }

  let tenant = tenantByChatId(chatId)
  if (isSuperAdmin(msg.from?.id)) tenant = getTenant(adminTenant.get(String(chatId))) || tenant

  // Client tapped the site's "get notifications" deep link:
  // /start <tenantId>_<eventId> → remember their chat on that booking.
  if (cmd === '/start') {
    const payload = text.split(/\s+/)[1] || ''
    const sep = payload.indexOf('_')
    if (sep > 0) {
      const t = getTenant(payload.slice(0, sep))
      if (t?.calendarId && isCalendarConfigured()) {
        try {
          await setClientChat(payload.slice(sep + 1), chatId, t.calendarId)
          return sendMessage(
            chatId,
            "🔔 Done! I'll message you here if your appointment is confirmed, rescheduled or cancelled."
          )
        } catch {
          return sendMessage(chatId, '⚠️ This booking was not found — it may have been cancelled already.')
        }
      }
    }
  }

  // Unknown chat: a subscribed client sees their bookings; anyone else gets
  // the onboarding hint with their chat id.
  if (!tenant) {
    if (cmd === '/start' || cmd === '/menu') {
      const mine = await clientBookingsAcrossTenants(chatId)
      if (mine.length) {
        const lines = mine.map(
          (b) =>
            `• ${dayLabelEn(b.date)} ${b.time} — ${b.service || 'booking'} (${b.master})` +
            (b.status === 'pending' ? ' 🟡 awaiting confirmation' : ' ✅ confirmed')
        )
        return sendMessage(chatId, `📒 <b>Your appointments</b>\n\n${lines.join('\n')}`)
      }
      await sendMessage(
        chatId,
        `👋 Этот чат пока не подключён.\nВаш ID: <code>${chatId}</code>\nПередайте его администратору для подключения.`
      )
    }
    return
  }

  if (!isTenantAdmin(tenant, msg.from?.id)) return
  const ctx = { chatId, tenant, calendarId: tenant.calendarId, tz: tenant.timezone, availability: tenant.availability || [] }

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
        curated: await curatedFor(ctx),
      })
      await sendPhotoBuffer(chatId, buf, '📅 Свободные окна на месяц')
    }
    return
  }

  if (cmd === '/start' || cmd === '/menu') return sendMenu(ctx)

  // Adding a booking by hand: "ДД.ММ[.ГГГГ] ЧЧ:ММ Имя[, услуга]"
  if (awaitingNew.has(String(chatId))) {
    const parsed = parseNewBooking(text, ctx.tz)
    if (!parsed) {
      return sendMessage(chatId, '⚠️ Формат: <b>ДД.ММ ЧЧ:ММ Имя, услуга</b>, например <b>25.07 14:00 Анна, брови</b>.')
    }
    awaitingNew.delete(String(chatId))
    const booking = { ...parsed, contact: '', method: 'whatsapp', message: 'Добавлена вручную через бота' }
    const event = await createPendingEvent(booking, ctx.calendarId, ctx.tz)
    await confirmEvent(event.id, {}, ctx.calendarId, ctx.tz)
    return sendMessage(
      chatId,
      `✅ Запись добавлена: ${dayLabel(parsed.date)} ${parsed.time} — <b>${parsed.name}</b>${parsed.service ? ` (${parsed.service})` : ''}`
    )
  }

  // Master is sending the whole month's dates+times for the site
  if (awaitingMonth.has(String(chatId))) {
    const entries = parseMonthList(text, ctx.tz)
    if (!entries.length) {
      return sendMessage(
        chatId,
        '⚠️ Не удалось распознать. Каждая строка: <b>ДД.ММ время время…</b>, например <b>07.07 15:00 17:30</b>.'
      )
    }
    awaitingMonth.delete(String(chatId))
    const saved = await saveCurated(entries, ctx.calendarId, ctx.tz)
    if (!saved.length) return sendMessage(chatId, '⚠️ Все присланные даты уже в прошлом — ничего не сохранено.')
    const lines = saved.map((s) => `• ${dayLabel(s.date)}: ${s.times.join(', ')}`).join('\n')
    // ponytail: hard cut at Telegram's 4096-char message limit; a real month never hits it
    return sendMessage(chatId, `✅ Время записи на сайте обновлено:\n${lines}`.slice(0, 4000))
  }

  // Master is sending the list of times to show on their site
  if (awaitingSlots.has(String(chatId))) {
    const times = parseSlotList(text)
    if (!times.length) {
      return sendMessage(
        chatId,
        '⚠️ Не удалось распознать времена. Пришли их через запятую, например <b>10:00, 12:00, 14:00</b>.'
      )
    }
    awaitingSlots.delete(String(chatId))
    const saved = await setSlots(times, ctx.calendarId)
    return sendMessage(chatId, `✅ Общее время (на все дни) обновлено:\n<b>${saved.join(', ')}</b>`)
  }

  const pending = awaitingTime.get(String(chatId))
  if (!pending) return

  const parsed = parseTime(msg.text || '')
  if (!parsed) {
    return sendMessage(chatId, '⚠️ Не удалось распознать время. Используй <b>ДД/ММ/ГГГГ ЧЧ:ММ</b> или <b>ЧЧ:ММ</b>.')
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
    rescheduled: true,
  })
}

async function finalizeConfirm({ ctx, eventId, messageId, originalText = '', date, time, callbackId, rescheduled = false }) {
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
      clientChatId: priv.clientChatId || '',
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

  const cal = gcalLink(info, ctx.tz)
  notifyClient(
    info.clientChatId,
    rescheduled
      ? `Hello, ${info.clientName || ''}! Your appointment was rescheduled: ${info.service || 'booking'}, now ${info.date} at ${info.time}. If the new time doesn't work, just message me. 💛`
      : confirmationTextForClient(info),
    cal ? { reply_markup: { inline_keyboard: [[{ text: '📅 Add to calendar', url: cal }]] } } : {}
  )

  if (rescheduled) {
    const whenStr = info.date ? `${dayLabel(info.date)}${info.time ? ' ' + info.time : ''}` : time || ''
    await sendMessage(ctx.chatId, `🔁 <b>Перезапись совершена</b>${whenStr ? ` — ${whenStr}` : ''}`)
  }
}

// ===========================================================================
// Scheduling menu (per-tenant via ctx.calendarId)
// ===========================================================================

const menuText = (t) => `⚙️ <b>Меню мастера</b>${t?.name ? ` — ${t.name}` : ''}\nУправление расписанием:`
const menuKeyboard = () => ({
  inline_keyboard: [
    [{ text: '📒 Записи клиентов (перенос / отмена)', callback_data: 'm|bookings' }],
    [{ text: '🚫 Заблокировать / освободить время', callback_data: 'm|block' }],
    [{ text: '🌴 Выходные дни', callback_data: 'm|dayoff' }],
    [{ text: '🕐 Время записи на сайте', callback_data: 'm|slots' }],
    [{ text: '📋 Расписание (месяц)', callback_data: 'm|list' }],
    [{ text: '🖼 Картинка для сторис', callback_data: 'm|story' }],
  ],
})

async function sendMenu(ctx) {
  if (!isCalendarConfigured()) {
    return sendMessage(ctx.chatId, '⚠️ Google Calendar ещё не подключён.')
  }
  return sendMessage(ctx.chatId, menuText(ctx.tenant), { reply_markup: menuKeyboard() })
}

function dayLabel(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' })
}

// Per-date times for the site/story: calendar-stored (bot-editable) wins,
// hardcoded tenant list is the fallback; taken slots and days off are hidden.
async function curatedFor(ctx) {
  const [stored, av] = await Promise.all([
    getCurated(ctx.calendarId),
    getAvailability(SCAN_DAYS, ctx.calendarId, ctx.tz),
  ])
  return filterCurated(stored.length ? stored : ctx.availability, av, ctx.tz)
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

// ---- site availability editor (per-date times shown in the site form) -------

const AVAIL_TIMES = (() => {
  const out = []
  for (let h = 8; h <= 20; h++) out.push(`${String(h).padStart(2, '0')}:00`, `${String(h).padStart(2, '0')}:30`)
  return out
})()

const availText = () =>
  '🕐 <b>Время записи на сайте</b>\n' +
  'Выбери дату и отметь времена — клиенты на сайте увидят только их.\n' +
  'Пока ни одна дата не задана, сайт показывает общее время на все дни.'

async function buildAvailKeyboard(calendarId, tz) {
  const curated = new Map((await getCurated(calendarId)).map((s) => [s.date, s.times]))
  const today = localToday(tz)
  const rows = []
  let row = []
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const date = addDays(today, i)
    const times = curated.get(date)
    row.push({
      text: times ? `🟢 ${dayLabel(date)} · ${times.length}` : dayLabel(date),
      callback_data: `av|${date}`,
    })
    if (row.length === 2) {
      rows.push(row)
      row = []
    }
  }
  if (row.length) rows.push(row)
  rows.push([{ text: '📆 Задать весь месяц списком', callback_data: 'av|month' }])
  rows.push([{ text: '🌍 Общее время (на все дни)', callback_data: 'av|global' }])
  rows.push([{ text: '⬅️ Меню', callback_data: 'm|home' }])
  return { inline_keyboard: rows }
}

function buildAvailDayKeyboard(date, times) {
  const sel = new Set(times)
  const rows = []
  let row = []
  for (const t of AVAIL_TIMES) {
    row.push({ text: sel.has(t) ? `🟢 ${t}` : t, callback_data: `at|${date}|${t}` })
    if (row.length === 4) {
      rows.push(row)
      row = []
    }
  }
  if (row.length) rows.push(row)
  rows.push([
    { text: '🧹 Очистить день', callback_data: `ac|${date}` },
    { text: '⬅️ К датам', callback_data: 'm|slots' },
  ])
  return { inline_keyboard: rows }
}

function buildSlotsKeyboard(date, status, slots = TIME_SLOTS) {
  const rows = []
  let row = []
  for (const t of slots) {
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

const cancelTextForClient = ({ clientName, service, date, time }) =>
  `Hello, ${clientName || ''}! Unfortunately I have to cancel your appointment (${service || 'booking'}, ${date} at ${time}). Please message me to find a new time. Sorry for the inconvenience! 💛`

// After a cancel, offer the client the master's nearest free slots so they can
// rebook right from the push. Returns a reply_markup or null.
async function rebookKeyboard(tenant, booking) {
  if (!tenant || !booking?.clientChatId) return null
  try {
    const ctx = { calendarId: tenant.calendarId, tz: tenant.timezone, availability: tenant.availability || [] }
    const slots = (await curatedFor(ctx))
      .flatMap((s) => (s.times || []).map((t) => ({ date: s.date, time: t })))
      .slice(0, 6)
    if (!slots.length) return null
    rebookCtx.set(String(booking.clientChatId), {
      tenantId: tenant.id,
      name: booking.clientName || '',
      method: booking.method || 'whatsapp',
      contact: booking.contact || '',
      service: booking.service || '',
    })
    return {
      inline_keyboard: slots.map((s) => [
        { text: `📅 ${dayLabelEn(s.date)} · ${s.time}`, callback_data: `cl|${s.date}|${s.time}` },
      ]),
    }
  } catch {
    return null
  }
}

// Client tapped a rebook slot in the cancel push
async function onClientRebook(cq) {
  const chatId = cq.message?.chat?.id
  const [, date, time] = (cq.data || '').split('|')
  const saved = rebookCtx.get(String(chatId))
  const tenant = saved && getTenant(saved.tenantId)
  if (!tenant?.calendarId) {
    await editMessageReplyMarkup(chatId, cq.message?.message_id, { inline_keyboard: [] })
    return answerCallback(cq.id, 'This offer has expired — please book on the site.')
  }
  rebookCtx.delete(String(chatId))
  const booking = { ...saved, date, time, message: 'Rebooked via bot after cancellation' }
  const event = await createPendingEvent(booking, tenant.calendarId, tenant.timezone)
  await setPrivateProps(event.id, { clientChatId: String(chatId) }, tenant.calendarId).catch(() => {})
  await sendBookingToMaster(booking, event, tenant)
  await editMessageReplyMarkup(chatId, cq.message?.message_id, { inline_keyboard: [] })
  await sendMessage(
    chatId,
    `✅ Request sent: ${booking.service || 'booking'}, ${dayLabelEn(date)} at ${time}. You'll get a message here once it's confirmed.`
  )
  return answerCallback(cq.id, 'Request sent')
}

function bookingDetailText(b) {
  const channel =
    b.method === 'telegram' ? '✈️ Telegram' : b.method === 'instagram' ? '📷 Instagram' : '🟢 WhatsApp'
  const st = b.status === 'pending' ? '🟡 Ожидает подтверждения' : '✅ Подтверждена'
  return (
    `📒 <b>Запись клиента</b>\n\n` +
    `👤 <b>${b.clientName || '—'}</b>\n` +
    `💅 ${b.service || '—'}\n` +
    `📅 ${dayLabel(b.date)} 🕐 ${b.time || '—'}\n` +
    `${channel}: ${b.contact || '—'}\n` +
    `${st}`
  )
}

async function buildBookingsKeyboard(calendarId, tz) {
  const list = await listBookings(calendarId, tz)
  const rows = list.map((b) => [
    {
      text: `${b.status === 'pending' ? '🟡' : '✅'} ${dayLabel(b.date)} ${b.time} · ${b.clientName || '—'}`,
      callback_data: `bk|${b.id}`,
    },
  ])
  rows.push([{ text: '➕ Добавить запись', callback_data: 'm|newbk' }])
  rows.push([{ text: '⬅️ Меню', callback_data: 'm|home' }])
  return { markup: { inline_keyboard: rows }, empty: list.length === 0 }
}

async function onMenuCallback(data, callbackId, messageId, ctx) {
  if (!isCalendarConfigured()) return answerCallback(callbackId, 'Календарь не подключён')
  const parts = data.split('|')
  const action = parts[0]
  const cid = ctx.calendarId
  const chatId = ctx.chatId

  // Any menu tap cancels pending text prompts (the handlers below re-arm them).
  awaitingSlots.delete(String(chatId))
  awaitingMonth.delete(String(chatId))
  awaitingTime.delete(String(chatId))
  awaitingNew.delete(String(chatId))

  if (action === 'm') {
    const sub = parts[1]
    if (sub === 'home') {
      await editMessageText(chatId, messageId, menuText(ctx.tenant), { reply_markup: menuKeyboard() })
    } else if (sub === 'bookings') {
      const { markup, empty } = await buildBookingsKeyboard(cid, ctx.tz)
      await editMessageText(
        chatId,
        messageId,
        empty
          ? '📒 <b>Записи клиентов</b>\n\nАктивных записей нет.'
          : '📒 <b>Записи клиентов</b>\nВыбери запись, чтобы перенести или отменить:',
        { reply_markup: markup }
      )
    } else if (sub === 'newbk') {
      awaitingNew.set(String(chatId), ctx)
      await sendMessage(
        chatId,
        '➕ Пришли запись как <b>ДД.ММ ЧЧ:ММ Имя, услуга</b>\nНапример: <code>25.07 14:00 Анна, брови</code>'
      )
    } else if (sub === 'slots') {
      await editMessageText(chatId, messageId, availText(), {
        reply_markup: await buildAvailKeyboard(cid, ctx.tz),
      })
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
    const buf = await renderScheduleImage({ lang, calendarId: cid, tz: ctx.tz, curated: await curatedFor(ctx) })
    await sendPhotoBuffer(chatId, buf, '📅 Свободные окна на месяц')
    return
  }

  // ---- site availability editor ---------------------------------------------
  if (action === 'av') {
    const arg = parts[1]
    if (arg === 'global') {
      awaitingSlots.set(String(chatId), ctx)
      const slots = await getSlots(cid)
      await editMessageText(
        chatId,
        messageId,
        `🌍 <b>Общее время (на все дни)</b>\nИспользуется, пока даты не заданы кнопками.\nСейчас: <b>${slots.join(', ')}</b>\n\n` +
          'Пришли новый список времён через запятую, например <b>10:00, 12:00, 14:00, 16:00, 18:00</b>.',
        { reply_markup: { inline_keyboard: [[{ text: '⬅️ К датам', callback_data: 'm|slots' }]] } }
      )
      return answerCallback(callbackId)
    }
    if (arg === 'month') {
      awaitingMonth.set(String(chatId), ctx)
      await editMessageText(
        chatId,
        messageId,
        '📆 <b>Весь месяц одним сообщением</b>\nПришли список: каждая строка — дата и времена. Например:\n\n' +
          '<code>03.07 09:30\n07.07 15:00 17:30\n08.07 08:30 10:00</code>\n\n' +
          '⚠️ Список на сайте будет заменён целиком.',
        { reply_markup: { inline_keyboard: [[{ text: '⬅️ К датам', callback_data: 'm|slots' }]] } }
      )
      return answerCallback(callbackId)
    }
    const times = (await getCurated(cid)).find((s) => s.date === arg)?.times || []
    await editMessageText(
      chatId,
      messageId,
      `🕐 <b>${dayLabel(arg)}</b>\nОтметь времена, доступные для записи на сайте:`,
      { reply_markup: buildAvailDayKeyboard(arg, times) }
    )
    return answerCallback(callbackId)
  }

  if (action === 'at') {
    const [, date, time] = parts
    const times = await toggleCuratedTime(date, time, cid, ctx.tz)
    await editMessageReplyMarkup(chatId, messageId, buildAvailDayKeyboard(date, times))
    return answerCallback(callbackId, times.includes(time) ? `🟢 ${time} добавлено` : `${time} убрано`)
  }

  if (action === 'ac') {
    const date = parts[1]
    const list = await getCurated(cid)
    if (!list.some((s) => s.date === date)) return answerCallback(callbackId, 'День уже пуст')
    await saveCurated(list.filter((s) => s.date !== date), cid, ctx.tz)
    await editMessageReplyMarkup(chatId, messageId, buildAvailDayKeyboard(date, []))
    return answerCallback(callbackId, '🧹 День очищен')
  }

  if (action === 'bd') {
    const date = parts[1]
    const [{ dayoff, status }, slots] = await Promise.all([getDayStatus(date, cid), getSlots(cid)])
    await editMessageText(
      chatId,
      messageId,
      `🚫 <b>${dayLabel(date)}</b>\n${dayoff ? '🌴 Выходной день\n' : ''}Нажми на слот, чтобы заблокировать / освободить:`,
      { reply_markup: buildSlotsKeyboard(date, status, slots) }
    )
    return answerCallback(callbackId)
  }

  if (action === 'bt') {
    const [, date, time] = parts
    const result = await toggleBlock(date, time, cid, ctx.tz)
    if (result === 'booked') return answerCallback(callbackId, '📅 Этот слот занят записью клиента')
    const [{ status }, slots] = await Promise.all([getDayStatus(date, cid), getSlots(cid)])
    await editMessageReplyMarkup(chatId, messageId, buildSlotsKeyboard(date, status, slots))
    return answerCallback(callbackId, result === 'blocked' ? '🚫 Заблокировано' : '🟢 Освобождено')
  }

  if (action === 'ba' || action === 'bc') {
    const date = parts[1]
    if (action === 'ba') await blockWholeDay(date, cid, ctx.tz)
    else await unblockWholeDay(date, cid)
    const [{ status }, slots] = await Promise.all([getDayStatus(date, cid), getSlots(cid)])
    await editMessageReplyMarkup(chatId, messageId, buildSlotsKeyboard(date, status, slots))
    return answerCallback(callbackId, action === 'ba' ? '🚫 День заблокирован' : '🟢 День освобождён')
  }

  if (action === 'do') {
    const date = parts[1]
    const result = await toggleDayOff(date, cid)
    await editMessageReplyMarkup(chatId, messageId, await buildDaysKeyboard('dayoff', cid, ctx.tz))
    return answerCallback(callbackId, result === 'added' ? '🌴 Выходной добавлен' : '✅ Выходной снят')
  }

  // ---- client bookings: open one, reschedule or cancel it -------------------
  if (action === 'bk' || action === 'br' || action === 'bx' || action === 'bxy') {
    const id = parts[1]
    const booking = (await listBookings(cid, ctx.tz)).find((b) => b.id === id)

    // The record is gone (already cancelled elsewhere) — fall back to the list.
    if (!booking && action !== 'bxy') {
      const { markup } = await buildBookingsKeyboard(cid, ctx.tz)
      await editMessageText(chatId, messageId, '📒 <b>Записи клиентов</b>\n\nЭта запись уже неактуальна.', {
        reply_markup: markup,
      })
      return answerCallback(callbackId, 'Запись не найдена')
    }

    if (action === 'bk') {
      await editMessageText(chatId, messageId, bookingDetailText(booking), {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🕐 Перенести', callback_data: `br|${id}` }],
            [{ text: '❌ Отменить запись', callback_data: `bx|${id}` }],
            [{ text: '⬅️ К записям', callback_data: 'm|bookings' }],
          ],
        },
      })
      return answerCallback(callbackId)
    }

    if (action === 'br') {
      awaitingTime.set(String(chatId), { eventId: id, messageId, originalText: bookingDetailText(booking), ctx })
      await sendMessage(
        chatId,
        '🕐 Пришли новое время как <b>ДД/ММ/ГГГГ ЧЧ:ММ</b> (или просто <b>ЧЧ:ММ</b>, чтобы оставить дату).'
      )
      return answerCallback(callbackId, 'Жду новое время')
    }

    if (action === 'bx') {
      await editMessageText(
        chatId,
        messageId,
        `${bookingDetailText(booking)}\n\n⚠️ Точно отменить эту запись?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Да, отменить', callback_data: `bxy|${id}` }],
              [{ text: '⬅️ Назад', callback_data: `bk|${id}` }],
            ],
          },
        }
      )
      return answerCallback(callbackId)
    }

    if (action === 'bxy') {
      if (booking) {
        await deleteEvent(id, cid)
        const kb = await rebookKeyboard(ctx.tenant, booking)
        notifyClient(
          booking.clientChatId,
          cancelTextForClient(booking) + (kb ? '\n\nOr pick a new time right here:' : ''),
          kb ? { reply_markup: kb } : {}
        )
      }
      const btn = booking ? messageClientButton(booking.method, booking.contact, cancelTextForClient(booking)) : null
      const summary =
        '❌ <b>Запись отменена</b>' +
        (booking ? `\n${dayLabel(booking.date)} ${booking.time} · ${booking.clientName || ''}` : '')
      await editMessageText(chatId, messageId, summary, {
        reply_markup: {
          inline_keyboard: [
            ...(btn ? [[btn]] : []),
            [{ text: '⬅️ К записям', callback_data: 'm|bookings' }],
          ],
        },
      })
      return answerCallback(callbackId, 'Отменено')
    }
  }

  return answerCallback(callbackId)
}

// "ДД.ММ[.ГГГГ] ЧЧ:ММ Имя[, услуга]" → { date, time, name, service } | null.
// Year defaults to the current one; a date already past rolls to next year.
export function parseNewBooking(input, tz) {
  const m = input.trim().match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}))?\s+(\d{1,2}[:.]\d{2})\s+(.+)$/)
  if (!m) return null
  const time = pad(m[4].replace('.', ':'))
  if (!time) return null
  const today = localToday(tz)
  const year = m[3] || today.slice(0, 4)
  let date = `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  if (!m[3] && date < today) date = `${Number(year) + 1}${date.slice(4)}`
  if (!isRealDate(date)) return null
  const [name, ...svc] = m[5].split(',')
  return { date, time, name: name.trim(), service: svc.join(',').trim() }
}

export function parseTime(input) {
  const s = input.trim()
  // День/Месяц/Год + время, разделители / . - (например 25/06/2026 14:00)
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})[ T](\d{1,2}:\d{2})$/)
  if (m) {
    const [, d, mo, y, t] = m
    const date = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
    const time = pad(t)
    // Impossible dates/times (31/02, 25:70) would silently die at Google —
    // reject here so the master gets the "couldn't parse" reply instead.
    if (!time || !isRealDate(date)) return null
    return { date, time }
  }
  // Только время — дата записи сохраняется
  m = s.match(/^(\d{1,2}:\d{2})$/)
  if (m) {
    const time = pad(m[1])
    return time ? { date: '', time } : null
  }
  return null
}

// V8 rolls impossible days over (Feb 31 → Mar 3) instead of NaN — roundtrip to detect
const isRealDate = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso
}

const pad = (hhmm) => {
  const [h, m] = hhmm.split(':')
  if (parseInt(h, 10) > 23 || parseInt(m, 10) > 59) return null
  return `${h.padStart(2, '0')}:${m}`
}

// One month in free text: each line "ДД.ММ[.ГГГГ] время время…" → [{date, times}].
// Year defaults to the current one; a date already past rolls to next year.
function parseMonthList(input, tz) {
  const today = localToday(tz)
  const entries = []
  for (const line of input.split('\n')) {
    const m = line.match(/^\s*(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}|\d{2}(?![\d:])))?\s*[:—-]?\s*(.*)$/)
    if (!m) continue
    const [, d, mo, y, rest] = m
    if (+d < 1 || +d > 31 || +mo < 1 || +mo > 12) continue
    const times = parseSlotList(rest)
    if (!times.length) continue
    const year = y ? (y.length === 2 ? `20${y}` : y) : today.slice(0, 4)
    let date = `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
    if (!y && date < today) date = `${Number(year) + 1}${date.slice(4)}`
    if (!isRealDate(date)) continue
    entries.push({ date, times })
  }
  return entries
}

// ===========================================================================
// Periodic tasks (index.js runs this every 15 min): 24h client reminders,
// post-visit review asks, morning summary for each master.
// ===========================================================================

// ponytail: in-memory "summary sent" day-stamps — a restart between 8:00 and
// 8:59 may repeat one morning summary; harmless for a handful of tenants.
const summarySent = new Map()

async function clientBookingsAcrossTenants(chatId) {
  const out = []
  for (const t of TENANTS) {
    if (!t.calendarId) continue
    const list = await getClientBookings(chatId, t.calendarId).catch(() => [])
    for (const b of list) out.push({ ...b, master: t.name })
  }
  return out.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
}

export async function runPeriodicTasks() {
  if (!isTelegramConfigured() || !isCalendarConfigured()) return
  for (const tenant of TENANTS) {
    if (!tenant.calendarId) continue
    try {
      await tenantPeriodic(tenant)
    } catch (err) {
      console.error(`periodic [${tenant.id}]:`, err)
    }
  }
}

async function tenantPeriodic(tenant) {
  const bookings = await listBookings(tenant.calendarId, tenant.timezone)
  const now = Date.now()

  for (const b of bookings) {
    if (!b.clientChatId) continue

    // 24h reminder (flag first so a crash can't double-send)
    const untilStart = b.startISO ? Date.parse(b.startISO) - now : -1
    if (!b.reminded && untilStart > 0 && untilStart <= 24 * 3600e3) {
      await setPrivateProps(b.id, { reminded: '1' }, tenant.calendarId)
      notifyClient(
        b.clientChatId,
        `⏰ Reminder: ${b.service || 'your appointment'} ${dayLabelEn(b.date)} at ${b.time}. See you soon! 💛`
      )
    }

    // Review ask 2–6h after a confirmed visit ended
    const sinceEnd = b.endISO ? now - Date.parse(b.endISO) : -1
    if (!b.reviewAsked && b.status === 'confirmed' && sinceEnd > 2 * 3600e3 && sinceEnd < 6 * 3600e3) {
      await setPrivateProps(b.id, { reviewAsked: '1' }, tenant.calendarId)
      const ig = tenant.instagram
        ? { reply_markup: { inline_keyboard: [[{ text: '📷 Instagram', url: `https://instagram.com/${tenant.instagram}` }]] } }
        : {}
      notifyClient(
        b.clientChatId,
        `Hello, ${b.clientName || ''}! Hope you love the result ✨ A short review would mean a lot — just drop me a line on Instagram. Thank you! 💛`,
        ig
      )
    }
  }

  // Morning summary to the master at 8:00 local time
  const { date: today, hour } = nowInTz(tenant.timezone)
  if (hour === 8 && summarySent.get(tenant.id) !== today && tenant.telegramChatId) {
    summarySent.set(tenant.id, today)
    const todays = bookings.filter((b) => b.date === today)
    if (todays.length) {
      const lines = todays.map(
        (b) => `• ${b.time} — ${b.clientName || '—'} (${b.service || '—'})${b.status === 'pending' ? ' 🟡' : ''}`
      )
      await sendMessage(tenant.telegramChatId, `☀️ <b>Записи на сегодня: ${todays.length}</b>\n\n${lines.join('\n')}`)
    }
  }
}

// Pull every HH:MM out of free text, normalize and dedupe, e.g.
// "10, 12:00 14.00" → ['10:00', '12:00', '14:00']. (Lone hours like "10" → 10:00)
function parseSlotList(input) {
  const tokens = input.match(/\d{1,2}(?:[:.]\d{2})?/g) || []
  const set = new Set()
  for (const tok of tokens) {
    const [h, m = '00'] = tok.split(/[:.]/)
    const hour = parseInt(h, 10)
    if (hour > 23 || parseInt(m, 10) > 59) continue
    set.add(`${String(hour).padStart(2, '0')}:${m.padStart(2, '0')}`)
  }
  return [...set].sort()
}
