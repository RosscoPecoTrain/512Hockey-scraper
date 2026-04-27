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

    // Step 1: Open the page
    let openCmd = `agent-browser open "${url}"`;
    
    if (browserMode === 'headed') {
      openCmd += ' --headed';
    }
    
    if (recordVideo) {
      const videoFile = path.join(process.cwd(), `scrape-${Date.now()}.webm`);
      openCmd += ` --record "${videoFile}"`;
      console.log(`Recording video to: ${videoFile}`);
    }

    openCmd += ' --wait 3000';

    console.log(`Opening browser...`);
    try {
      execSync(openCmd, { 
        encoding: 'utf-8',
        stdio: 'pipe',
        maxBuffer: 10 * 1024 * 1024
      });
    } catch (e) {
      console.log('⚠️  agent-browser open error:', e.message);
    }

    // Step 2: Extract events using JavaScript evaluation
    console.log('Extracting events via JavaScript...');
    
    const jsCode = `
      const events = [];
      
      // Find all event elements - try multiple selectors
      const eventItems = document.querySelectorAll(
        'div[class*="event"], li[class*="event"], [role="listitem"], .calendar-event, .event-item'
      );
      
      console.log('Found ' + eventItems.length + ' potential event items');
      
      eventItems.forEach((item) => {
        const text = item.textContent || '';
        
        // Look for drop-in hockey events
        if (!text.match(/drop.?in|hockey/i)) return;
        
        // Extract title
        let title = '';
        const titleEl = item.querySelector('strong, b, h3, h4, a');
        if (titleEl) {
          title = titleEl.textContent.trim();
        } else {
          title = text.split('\\n')[0].trim();
        }
        
        // Extract time (e.g., "6:30 AM - 7:45 AM")
        const timeMatch = text.match(/(\\d{1,2}):(\\d{2})\\s*(am|pm|AM|PM)\\s*-\\s*(\\d{1,2}):(\\d{2})\\s*(am|pm|AM|PM)/i);
        if (!timeMatch) return; // Skip if no time found
        
        const timeText = timeMatch[0];
        
        if (title && title.length > 3) {
          events.push({
            title: title,
            timeText: timeText,
            fullText: text
          });
        }
      });
      
      JSON.stringify(events);
    `;

    // Escape the code for shell
    const escapedCode = jsCode.replace(/"/g, '\\"').replace(/\n/g, ' ');
    const evalCmd = `agent-browser act --eval "${escapedCode}"`;
    
    console.log('Running:', evalCmd);
    let evalOutput;
    
    try {
      evalOutput = execSync(evalCmd, { 
        encoding: 'utf-8',
        stdio: 'pipe',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000
      });
    } catch (e) {
      console.log('⚠️  agent-browser eval error:', e.message);
      evalOutput = e.stdout || '[]';
    }

    // Parse the output
    console.log('Raw eval output:', evalOutput.substring(0, 500));
    
    let events = [];
    try {
      // Extract JSON from the output (it might be wrapped in text)
      const jsonMatch = evalOutput.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        events = JSON.parse(jsonMatch[0]);
      } else if (evalOutput.trim().startsWith('[')) {
        events = JSON.parse(evalOutput.trim());
      } else {
        console.log('Could not find JSON in output');
      }
    } catch (e) {
      console.error('Error parsing JSON:', e.message);
      events = [];
    }

    console.log(`Found ${events.length} Hockey Drop In events`);
    
    if (events.length === 0) {
      console.log('⚠️  No events found. Trying fallback screenshot method...');
      // Take a screenshot for manual inspection
      try {
        execSync('agent-browser act --screenshot screenshot.png', { stdio: 'pipe' });
        console.log('✓ Screenshot saved to screenshot.png for inspection');
      } catch (e) {
        console.log('Could not capture screenshot');
      }
    }

    // Process and insert events into Supabase
    for (const event of events) {
      const { title, timeText, fullText } = event;

      console.log(`Processing: ${title}`);

      // Parse times from text like "6:30am - 7:45am"
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
        console.log(`⚠️  Could not parse time from: "${timeText}"`);
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

scrapeEvents();

cron.schedule('0 */6 * * *', () => {
  console.log('Cron triggered, starting scrape...');
  scrapeEvents();
});

console.log('\n🏒 Scraper started. Scheduled to run every 6 hours.');
console.log(`Browser mode: ${browserMode}`);
console.log(`Video recording: ${recordVideo ? 'enabled' : 'disabled'}`);
console.log(`Next scheduled run: 6 hours from startup time.\n`);
