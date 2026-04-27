require('dotenv').config();

const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const daysmart_url = 'https://apps.daysmartrecreation.com/dash/x/#/online/chaparralice/calendar';
const browserMode = process.env.BROWSER_MODE || 'headless';
const recordVideo = process.env.RECORD_VIDEO === 'true';

const supabase = createClient(supabaseUrl, supabaseKey);

async function scrapeEvents() {
  console.log(`[${new Date().toISOString()}] Starting scrape...`);
  
  try {
    const today = new Date().toISOString().split('T')[0];
    const in7days = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
    
    const url = `${daysmart_url}?start=${today}&end=${in7days}&event_type=9&location=1`;

    console.log(`Navigating to: ${url}`);
    console.log(`Browser mode: ${browserMode}`);

    let agentBrowserCmd = `agent-browser open "${url}"`;
    
    if (browserMode === 'headed') {
      agentBrowserCmd += ' --headed';
    }
    
    if (recordVideo) {
      const videoFile = path.join(process.cwd(), `scrape-${Date.now()}.webm`);
      agentBrowserCmd += ` --record "${videoFile}"`;
      console.log(`Recording video to: ${videoFile}`);
    }

    agentBrowserCmd += ' --wait 3000 --snapshot';

    console.log(`Running: ${agentBrowserCmd}`);
    let snapshotOutput;
    
    try {
      snapshotOutput = execSync(agentBrowserCmd, { 
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024
      });
    } catch (e) {
      console.log('agent-browser output:', e.stdout || e.message);
      snapshotOutput = e.stdout || '';
    }

    console.log('Parsing events from page...');
    const events = parseEventsFromSnapshot(snapshotOutput);

    console.log(`Found ${events.length} Hockey Drop In events`);
    
    if (events.length === 0) {
      console.log('No events found on page.');
    }

    for (const event of events) {
      const { title, timeText, fullText } = event;

      console.log(`Processing: ${title}`);

      const timeMatch = fullText.match(/(\d{1,2}):(\d{2})(am|pm)\s*-\s*(\d{1,2}):(\d{2})(am|pm)/i);
      let startTime, endTime;

      if (timeMatch) {
        const today = new Date();
        const [, startHour, startMin, startPeriod, endHour, endMin, endPeriod] = timeMatch;
        
        let start = parseInt(startHour);
        if (startPeriod.toLowerCase() === 'pm' && start !== 12) start += 12;
        if (startPeriod.toLowerCase() === 'am' && start === 12) start = 0;

        let end = parseInt(endHour);
        if (endPeriod.toLowerCase() === 'pm' && end !== 12) end += 12;
        if (endPeriod.toLowerCase() === 'am' && end === 12) end = 0;

        startTime = new Date(today.getFullYear(), today.getMonth(), today.getDate(), start, parseInt(startMin));
        endTime = new Date(today.getFullYear(), today.getMonth(), today.getDate(), end, parseInt(endMin));
      } else {
        startTime = new Date();
        endTime = new Date(startTime.getTime() + 75 * 60000);
      }

      let locationId = null;
      try {
        const { data: locationData, error: locError } = await supabase
          .from('locations')
          .select('id')
          .eq('name', 'Chaparral Ice')
          .single();
        if (locError) {
          console.log('Location lookup error:', locError.message);
        } else {
          locationId = locationData?.id;
          console.log('Found locationId:', locationId);
        }
      } catch (err) {
        console.log('Location exception:', err.message);
      }

      let eventTypeId = null;
      try {
        const { data: eventTypeData, error: typeError } = await supabase
          .from('event_types')
          .select('id')
          .eq('name', 'Drop-In Hockey')
          .single();
        if (typeError) {
          console.log('Event type lookup error:', typeError.message);
        } else {
          eventTypeId = eventTypeData?.id;
          console.log('Found eventTypeId:', eventTypeId);
        }
      } catch (err) {
        console.log('Event type exception:', err.message);
      }

      const externalId = `daysmart-${title.replace(/\s+/g, '-')}-${startTime.getTime()}`;
      
      const { error } = await supabase
        .from('events')
        .upsert(
          {
            title,
            description: `${title} at Chaparral Ice`,
            start_time: startTime.toISOString(),
            end_time: endTime.toISOString(),
            location_id: locationId,
            event_type_id: eventTypeId,
            registration_url: url,
            source_url: url,
            external_event_id: externalId,
            scraped_at: new Date().toISOString()
          },
          { onConflict: 'external_event_id' }
        );

      if (error) {
        console.error(`Error inserting event: ${error.message}`);
      } else {
        console.log(`✓ Inserted/updated: ${title}`);
      }
    }

    console.log(`[${new Date().toISOString()}] Scrape completed`);

  } catch (error) {
    console.error('Scrape error:', error);
  }
}

function parseEventsFromSnapshot(text) {
  const events = [];
  
  // Look for patterns like "Adult Drop-in Player 4/28/26 6:30am"
  // or "Adult Drop-in Goalie 4/28/26 6:30am" followed by time range
  const eventRegex = /(Adult\s+Drop-in\s+\w+)\s+(\d{1,2}\/\d{1,2}\/\d{2})\s+(\d{1,2}:\d{2}(?:am|pm)?)/gi;
  
  let match;
  while ((match = eventRegex.exec(text)) !== null) {
    const [fullMatch, title, date, startTimeStr] = match;
    
    // Look ahead in the text for time range (e.g., "6:30am - 7:45am")
    const nextChars = text.substring(match.index + fullMatch.length, match.index + fullMatch.length + 50);
    const timeRangeMatch = nextChars.match(/(\d{1,2}:\d{2}(?:am|pm)?)\s*-\s*(\d{1,2}:\d{2}(?:am|pm)?)/i);
    
    let timeText = '';
    if (timeRangeMatch) {
      timeText = `${timeRangeMatch[1]} - ${timeRangeMatch[2]}`;
    } else if (startTimeStr) {
      // If we only have start time, estimate end time (75 min later)
      timeText = startTimeStr;
    }

    events.push({
      title: title.trim(),
      date: date,
      timeText: timeText,
      fullText: `${title.trim()} ${date} ${timeText}`
    });
  }
  
  return events;
}

scrapeEvents();

cron.schedule('0 */6 * * *', () => {
  console.log('Cron triggered, starting scrape...');
  scrapeEvents();
});

console.log('Scraper started. Scheduled to run every 6 hours.');
console.log(`Browser mode: ${browserMode}`);
console.log(`Video recording: ${recordVideo ? 'enabled' : 'disabled'}`);
