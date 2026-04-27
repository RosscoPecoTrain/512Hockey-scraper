# 512Hockey Scraper

Scrapes Hockey Drop In events from DaySmart Recreation and stores them in Supabase.

Uses [agent-browser](https://github.com/isaachansen/agent-browser) for browser automation — no Puppeteer, no system Chrome dependencies.

## Setup

```bash
npm install
agent-browser install  # One-time setup
```

Create `.env` from `.env.example`:

```bash
cp .env.example .env
# Edit .env with your Supabase credentials
```

## Usage

### Default (headless mode)
```bash
npm start
```

### Debug with visible browser
```bash
npm run start:headed
```

### Record video of run
```bash
npm run start:video
```
Videos are saved to `scrape-<timestamp>.webm`

## How it works

1. **Navigates** to DaySmart calendar filtered for Hockey Drop In events
2. **Extracts** event titles, times, and locations from the page
3. **Parses** time strings (e.g., "6:30am - 7:45am")
4. **Upserts** events to Supabase with deduplication via `external_event_id`
5. **Runs** automatically every 6 hours via cron

## Environment Variables

- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Your Supabase anon public key
- `BROWSER_MODE` - `headless` (default), `headed`, or `video`
- `RECORD_VIDEO` - `true` to record video (default: `false`)

## Scheduling

The scraper runs automatically every 6 hours. To change the schedule, edit the cron expression in `index.js`:

```javascript
cron.schedule('0 */6 * * *', () => {
  // runs at: 00:00, 06:00, 12:00, 18:00 UTC
});
```

Cron syntax: `minute hour day month dayOfWeek`
