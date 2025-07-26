import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

// For __dirname in ESM:
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use dotenv
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Google OAuth2 client setup
const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Scopes for Google Calendar
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
  'email'
];

app.use(express.json());

// Security middleware
app.use(helmet());
app.use(rateLimit({ windowMs: 1 * 60 * 1000, max: 60 })); // 60 req/min per IP

// Setup lowdb for persistent token storage
const dbFile = path.join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);
const db = new Low(adapter, { users: [] }); // Provide default data here

// Initialize db with users if not present
async function initDb() {
  await db.read();
  await db.write();
}

// Main startup - ALL database access and routes go here
(async () => {
  await initDb();

  // Helper functions that use db - defined AFTER initDb()
  async function getUser(email) {
    await db.read();
    return db.data.users.find(u => u.email === email);
  }

  async function saveUser(email, tokens) {
    await db.read();
    let user = db.data.users.find(u => u.email === email);
    if (user) {
      user.tokens = tokens;
    } else {
      db.data.users.push({ email, tokens });
    }
    await db.write();
  }

  // Cache and helper functions
  let cache = {};
  const CACHE_TTL_MS = 60 * 1000; // 1 minute

  function invalidateCache(email) {
    cache[email] = { events: null, summary: null, expiry: 0 };
  }

  // Middleware to ensure user is authenticated and set oAuth2Client
  async function ensureAuthenticated(req, res, next) {
    const email = req.header('X-User-Email');
    if (!email) return res.status(400).send('Missing X-User-Email header');
    const user = await getUser(email);
    if (!user || !user.tokens) {
      return res.status(401).send('Not authenticated. Go to /auth to login.');
    }
    oAuth2Client.setCredentials(user.tokens);
    req.userEmail = email;
    next();
  }

  // Fetch and process Google Calendar events for a user
  async function fetchProcessedEvents(email) {
    try {
      console.log('Fetching events for user:', email);
      const calendar = google.calendar({ version: 'v3', auth: oAuth2Client });
      const now = new Date();
      console.log('Making API call to Google Calendar...');
      const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin: now.toISOString(),
        maxResults: 20,
        singleEvents: true,
        orderBy: 'startTime',
      });
      console.log('Google Calendar API response received, events count:', res.data.items?.length || 0);
      const events = res.data.items || [];
      const processedEvents = events
        .filter(e => e.status !== 'cancelled' && e.start && e.end && (e.start.dateTime || e.start.date) && (e.end.dateTime || e.end.date))
        .map(e => {
          const start = e.start.dateTime || e.start.date;
          const end = e.end.dateTime || e.end.date;
          const durationMinutes = Math.round((new Date(end) - new Date(start)) / (1000 * 60));
          return {
            id: e.id,
            title: e.summary || 'No Title',
            start,
            end,
            durationMinutes,
            location: e.location || '',
            attendees: (e.attendees || []).map(a => a.email),
          };
        });
      console.log('Processed events count:', processedEvents.length);
      return processedEvents;
    } catch (error) {
      console.error('Error in fetchProcessedEvents:', error.message);
      console.error('Full error:', error);
      throw error;
    }
  }

  // Routes - ALL defined AFTER initDb()
  app.get('/', (req, res) => {
    res.send('Google Calendar Event Dashboard API');
  });

  // Route to start OAuth2 flow
  app.get('/auth', (req, res) => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });
    res.redirect(authUrl);
  });

  // OAuth2 callback route
  app.get('/oauth2callback', async (req, res) => {
    const code = req.query.code;
    console.log('OAuth2 callback received, code:', code ? 'present' : 'missing');
    if (!code) return res.status(400).send('No code provided');
    try {
      console.log('Attempting to get token with code...');
      const { tokens } = await oAuth2Client.getToken(code);
      console.log('Token received successfully, tokens:', Object.keys(tokens));
      oAuth2Client.setCredentials(tokens);
      
      // Try multiple methods to get user email
      let email = null;
      
      // Method 1: Try ID token first
      if (tokens.id_token) {
        try {
          console.log('Trying to get email from ID token...');
          const ticket = await oAuth2Client.verifyIdToken({
            idToken: tokens.id_token,
            audience: process.env.GOOGLE_CLIENT_ID
          });
          const payload = ticket.getPayload();
          email = payload.email;
          console.log('Email from ID token:', email);
        } catch (idTokenError) {
          console.log('ID token method failed:', idTokenError.message);
        }
      }
      
      // Method 2: Try userinfo API as fallback
      if (!email && tokens.access_token) {
        try {
          console.log('Trying userinfo API...');
          const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
          const { data } = await oauth2.userinfo.get();
          email = data.email;
          console.log('Email from userinfo API:', email);
        } catch (userinfoError) {
          console.log('Userinfo API method failed:', userinfoError.message);
        }
      }
      
      // Method 3: Try token info as final fallback
      if (!email && tokens.access_token) {
        try {
          console.log('Trying token info...');
          const tokenInfo = await oAuth2Client.getTokenInfo(tokens.access_token);
          email = tokenInfo.email;
          console.log('Email from token info:', email);
        } catch (tokenInfoError) {
          console.log('Token info method failed:', tokenInfoError.message);
        }
      }
      
      console.log('Final email result:', email);
      
      if (!email) {
        console.log('All methods failed to get email');
        return res.status(400).send('Could not get user email from any method. Please check OAuth2 scopes.');
      }
      
      await saveUser(email, tokens);
      invalidateCache(email);
      res.send(`Authentication successful for ${email}! Use your email in the X-User-Email header for API requests.`);
    } catch (err) {
      console.error('OAuth2 callback error:', err.message);
      console.error('Full error:', err);
      res.status(500).send(`Error retrieving access token: ${err.message}`);
    }
  });

  // GET /events - list processed events (with cache, per user)
  app.get('/events', ensureAuthenticated, async (req, res) => {
    try {
      const email = req.userEmail;
      console.log('GET /events request for user:', email);
      const now = Date.now();
      if (cache[email] && cache[email].events && cache[email].expiry > now) {
        console.log('Returning cached events for user:', email);
        return res.json(cache[email].events);
      }
      console.log('Fetching fresh events for user:', email);
      const events = await fetchProcessedEvents(email);
      cache[email] = cache[email] || {};
      cache[email].events = events;
      cache[email].expiry = now + CACHE_TTL_MS;
      console.log('Returning fresh events, count:', events.length);
      res.json(events);
    } catch (err) {
      console.error('Error in GET /events:', err.message);
      console.error('Full error details:', err);
      res.status(500).json({ error: 'Failed to fetch events', details: err.message });
    }
  });

  // GET /events/summary - summary of events (with cache, per user) - MUST BE BEFORE /events/:id
  app.get('/events/summary', ensureAuthenticated, async (req, res) => {
    try {
      const email = req.userEmail;
      console.log('GET /events/summary request for user:', email);
      const now = Date.now();
      if (cache[email] && cache[email].summary && cache[email].expiry > now) {
        console.log('Returning cached summary for user:', email);
        return res.json(cache[email].summary);
      }
      console.log('Fetching fresh summary for user:', email);
      const events = await fetchProcessedEvents(email);
      let summary;
      if (events.length === 0) {
        summary = { totalEvents: 0, totalHours: 0, firstEventStart: null, lastEventEnd: null };
      } else {
        const totalEvents = events.length;
        const totalHours = events.reduce((sum, e) => sum + e.durationMinutes, 0) / 60;
        const firstEventStart = events[0].start;
        const lastEventEnd = events[events.length - 1].end;
        summary = { totalEvents, totalHours, firstEventStart, lastEventEnd };
      }
      cache[email] = cache[email] || {};
      cache[email].summary = summary;
      cache[email].expiry = now + CACHE_TTL_MS;
      console.log('Returning summary:', summary);
      res.json(summary);
    } catch (err) {
      console.error('Error in GET /events/summary:', err.message);
      console.error('Full error details:', err);
      res.status(500).json({ error: 'Failed to fetch summary', details: err.message });
    }
  });

  // GET /events/:id - single event details - MUST BE AFTER /events/summary
  app.get('/events/:id', ensureAuthenticated, async (req, res) => {
    try {
      const email = req.userEmail;
      console.log('GET /events/:id request for user:', email, 'id:', req.params.id);
      const events = await fetchProcessedEvents(email);
      const event = events.find(e => e.id === req.params.id);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      res.json(event);
    } catch (err) {
      console.error('Error in GET /events/:id:', err.message);
      console.error('Full error details:', err);
      res.status(500).json({ error: 'Failed to fetch event', details: err.message });
    }
  });

  // Start server AFTER all initialization
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})(); 