# Booking Hub

One shared backend (Telegram bot + Google Calendar) that serves **many masters'
sites**. The master sites are plain **static** sites; their booking forms call
this hub's API. This hub is **yours** (the admin), independent of any master's
site.

```
1 × Booking Hub  (this — Node Web Service: bot + /api + Google Calendar)
N × static sites (masters' frontends → POST to this hub with their tenant id)
```

## Run locally
```bash
npm install
npm start            # http://localhost:3001
```

## Deploy on Render (Web Service)
- New + → **Web Service** (or Blueprint with this `render.yaml`) → this repo.
- Build: `npm install` · Start: `npm start`.
- Set the env vars (see below). After deploy it auto-registers the Telegram webhook.

### Env vars (shared, set in Render dashboard)
| Key | What |
|-----|------|
| `TELEGRAM_BOT_TOKEN` | the one shared bot's token (@BotFather) |
| `TELEGRAM_WEBHOOK_SECRET` | any random string |
| `GOOGLE_CLIENT_EMAIL` | service account email (shared) |
| `GOOGLE_PRIVATE_KEY` | service account private key (with `\n`) |
| `TELEGRAM_MASTER_CHAT_ID` · `TELEGRAM_ADMIN_IDS` · `GOOGLE_CALENDAR_ID` · `STUDIO_TIMEZONE` | defaults for the first master ("alyona") that `server/tenants.js` reads |

`RENDER_EXTERNAL_URL` is provided by Render and used to register the webhook.

## Add a master
Edit `server/tenants.js` (add an entry: id, telegramChatId, adminIds, calendarId,
timezone) and push. The master shares their Google Calendar with
`GOOGLE_CLIENT_EMAIL` and presses Start on the bot (the bot replies with their
chat id). See the main project's `MULTITENANT.md` for the full walkthrough and a
ready-to-paste form snippet for any site.

## Connect a site's form
```
POST  <hub-url>/api/booking      { tenant, name, contact, method, service, date, time, message }
GET   <hub-url>/api/availability?tenant=<id>
```
CORS is open, so static sites on any domain can call it.
