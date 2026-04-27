require('dotenv').config();

const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables');
  process.exit(1);
}

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
      console.log('⚠️  agent-browser error:', e.message);
      snapshotOutput = e.stdout || '';
    }

    // Save snapshot for debugging
    fs.writeFileSync('snapshot.txt', snapshotOutput);
    console.log('✓ Snapshot saved to snapshot.txt');

    console.log('Parsing events from page...');
    const events = parseEventsFromSnapshot(snapshotOutput);

    console.log(`Found ${events.length} Hockey Drop In events`);
    
    if (events.length === 0) {
      console.log('⚠️  No events found on page.');
      console.log('First 1000 chars of snapshot:');
      console.log(snapshotOutput.substring(0, 1000));
    }

    for (const event of events) {
      const { title, timeText, fullText } = event;

      console.log(`Processing: ${title}`);

      // Parse times from text like "6:30am - 7:45am" or "6:30 AM - 7:45 AM"
      const timeRegex = /(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)/i;
      const timeMatch = (timeText || fullText).match(timeRegex);
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
        console.log(`⚠️  Could not parse time from: "${timeText}" or "${fullText}"`);
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

      // Use title + date as unique ID to avoid duplicates
      const externalId = `daysmart-${title.replace(/[^a-z0-9]/gi, '_')}-${startTime.toISOString().split('T')[0]}`;
      
      try {
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
          console.error(`✗ Error inserting event: ${error.message}`);
        } else {
          console.log(`✓ Inserted/updated: ${title} (${startTime.toLocaleTimeString()})`);
        }
      } catch (err) {
        console.error(`✗ Exception inserting event: ${err.message}`);
      }
    }

    console.log(`[${new Date().toISOString()}] Scrape completed`);

  } catch (error) {
    console.error('❌ Scrape error:', error.message);
  }
}

function parseEventsFromSnapshot(text) {
  const events = [];
  
  // Look for any "Drop-in" or "Hockey Drop In" patterns followed by time
  // Patterns: "Adult Drop-in Player", "Drop-In Goalie", "Hockey Drop In", etc.
  // Followed by date and time range
  
  // More flexible regex to catch various formats
  const eventRegex = /((?:Adult\s+)?Drop-?in\s+\w+|Hockey\s+Drop\s+In)\s+(\d{1,2}\/\d{1,2}\/\d{2})?.*?(\d{1,2}:\d{2}(?:am|pm)?(?:\s*-\s*\d{1,2}:\d{2}(?:am|pm)?)?)/gi;
  
  let match;
  const seenTitles = new Set();
  
  while ((match = eventRegex.exec(text)) !== null) {
    const [fullMatch, title, date, timeStr] = match;
    
    // Normalize title and avoid duplicates
    const normalizedTitle = title.trim().replace(/\s+/g, ' ');
    const key = `${normalizedTitle}-${date}`;
    
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    
    // Clean up time string
    let timeText = timeStr.trim();
    // If it's just start time, look ahead for end time
    if (!timeText.includes('-')) {
      const nextChars = text.substring(match.index + fullMatch.length, match.index + fullMatch.length + 30);
      const endTimeMatch = nextChars.match(/(\d{1,2}:\d{2}(?:am|pm)?)/i);
      if (endTimeMatch) {
        timeText = `${timeStr.trim()} - ${endTimeMatch[1]}`;
      }
    }

    events.push({
      title: normalizedTitle,
      date: date || new Date().toLocaleDateString(),
      timeText: timeText,
      fullText: `${normalizedTitle} ${date || ''} ${timeText}`.trim()
    });
  }

  // If regex didn't find anything, try a simpler pattern
  if (events.length === 0) {
    console.log('⚠️  Standard regex found no events, trying alternative patterns...');
    
    // Look for time patterns anywhere near drop-in text
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if ((line.includes('drop') || line.includes('Drop') || line.includes('HOCKEY') || line.includes('Hockey')) &&
          (line.match(/\d{1,2}:\d{2}/))) {
        
        // Extract time from this line
        const timeMatch = line.match(/(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?(?:\s*-\s*\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)?)/i);
        if (timeMatch) {
          events.push({
            title: line.substring(0, 50).trim(),
            timeText: timeMatch[0].trim(),
            fullText: line.trim()
          });
        }
      }
    }
  }
  
  return events;
}

scrapeEvents();

cron.schedule('0 */6 * * *', () => {
  console.log('Cron triggered, starting scrape...');
  scrapeEvents();
});

console.log('\n🏒 Scraper started. Scheduled to run every 6 hours.');
console.log(`Browser mode: ${browserMode}`);
console.log(`Video recording: ${recordVideo ? 'enabled' : 'disabled'}`);
console.log(`Next scheduled run: 6 hours from startup time.\n`);
