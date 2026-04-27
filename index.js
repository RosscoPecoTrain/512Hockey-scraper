require('dotenv').config();

const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const fs = require('fs');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables');
  process.exit(1);
}

const daysmart_url = 'https://apps.daysmartrecreation.com/dash/x/#/online/chaparralice/calendar';
const headlessBrowser = process.env.HEADLESS !== 'false'; // Set to false to see browser

const supabase = createClient(supabaseUrl, supabaseKey);

async function scrapeEvents() {
  console.log(`[${new Date().toISOString()}] Starting scrape...`);
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: headlessBrowser ? 'new' : false,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    // Build URL with date range and filters
    const today = new Date().toISOString().split('T')[0];
    const in7days = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
    
    // event_type=9 for "Hockey Drop In", location=1 for Chaparral Ice
    const url = `${daysmart_url}?start=${today}&end=${in7days}&event_type=9&location=1`;

    console.log(`Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

    // Wait for Angular to render the event list
    console.log('Waiting for Angular to render...');
    await page.waitForTimeout(3000); // Extra wait for Angular rendering
    
    // Try to find event cards - DaySmart uses various selectors
    await page.waitForSelector('[class*="event"], [role="listitem"], .calendar-event', { timeout: 10000 }).catch(() => {
      console.log('⚠️  Event selector not found, continuing anyway...');
    });

    // Save the HTML for debugging
    const html = await page.content();
    fs.writeFileSync('page.html', html);
    console.log('✓ Page HTML saved to page.html');

    // Extract events from the page
    const events = await page.evaluate(() => {
      const results = [];
      
      // Find all event list items - DaySmart uses various class/attribute patterns
      const eventItems = document.querySelectorAll(
        'dash-event-list-group-item, .list-group-item--app-item, [class*="event"], [role="listitem"], .calendar-event'
      );
      console.log(`Found ${eventItems.length} potential event items`);

      eventItems.forEach((item) => {
        const text = item.textContent || '';
        
        // Only capture "Hockey Drop In" / "Drop-in Player" events
        if (!text.includes('Drop-in') && !text.includes('Hockey Drop In') && !text.includes('Adult Drop-In')) return;

        // Extract title - look for it in various places
        let title = '';
        const titleLink = item.querySelector('a[href*="/teams/"], a[href*="online/"]');
        if (titleLink) {
          title = titleLink.textContent.trim();
        } else {
          // Fallback: get first line or bold text
          const bold = item.querySelector('strong, b, h3, h4');
          if (bold) {
            title = bold.textContent.trim();
          } else {
            // Last resort: first non-empty line of text
            title = text.split('\n')[0].trim();
          }
        }
        
        // Extract time (e.g., "6:30am - 7:45am" or "6:30 AM - 7:45 AM")
        const timeRegex = /(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm|AM|PM)/i;
        const timeMatch = text.match(timeRegex);
        const timeText = timeMatch ? timeMatch[0] : '';
        
        // Extract location (usually "Chaparral Ice" or similar)
        const locationText = 'Chaparral Ice'; // We know it's from the calendar URL

        // Only add if we have a title and time
        if (title && title.length > 3 && timeText) {
          results.push({
            title,
            timeText,
            locationText,
            fullText: text
          });
        }
      });

      console.log(`Extracted ${results.length} events`);
      return results;
    });

    console.log(`Found ${events.length} Hockey Drop In events`);
    
    if (events.length === 0) {
      console.log('⚠️  No events found. Dumping page structure for debugging...');
      const pageText = await page.evaluate(() => {
        const body = document.body.innerText;
        // Log more content to help debug selector issues
        const allText = body.substring(0, 2000);
        return allText;
      });
      console.log(pageText);
    }

    // Process and insert events into Supabase
    for (const event of events) {
      const { title, timeText, locationText, fullText } = event;

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
        console.log(`⚠️  Could not parse time from: "${timeText}" or "${fullText}"`);
        startTime = new Date();
        endTime = new Date(startTime.getTime() + 75 * 60000); // Default 75 min based on typical drop-in time
      }

      // Find location_id in Supabase
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

      // Find event_type_id
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

      // Upsert event
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

    await browser.close();
    console.log(`[${new Date().toISOString()}] Scrape completed`);

  } catch (error) {
    console.error('❌ Scrape error:', error.message);
    if (browser) await browser.close();
  }
}

// Run immediately on startup
scrapeEvents();

// Schedule to run every 6 hours
cron.schedule('0 */6 * * *', () => {
  console.log('Cron triggered, starting scrape...');
  scrapeEvents();
});

console.log('\n🏒 Scraper started. Scheduled to run every 6 hours.');
console.log(`Browser mode: ${headlessBrowser ? 'headless (hidden)' : 'visible (you can see it)'}`);
console.log(`Next scheduled run: 6 hours from startup time.\n`);
