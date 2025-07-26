# Google Calendar Event Dashboard API

A Node.js Express API to fetch, process, and expose your Google Calendar events.

## Features
- Google OAuth2 authentication (per user)
- Persistent token storage with lowdb (tokens saved per user)
- Multi-user support (identify user via X-User-Email header)
- Fetches next 20 upcoming events from your primary calendar
- REST API endpoints for events and summary
- Simple in-memory caching with TTL (per user)
- Security: helmet (HTTP headers), express-rate-limit (rate limiting)

## Tech Stack
- Node.js (v16+)
- Express.js
- googleapis
- dotenv
- lowdb (persistent storage)
- helmet, express-rate-limit (security)

## Setup

### 1. Clone & Install
```sh
npm install
```

### 2. Get Google OAuth2 Credentials
- Go to [Google Cloud Console](https://console.cloud.google.com/)
- Create a project, enable Google Calendar API
- Create OAuth2 credentials (Web application)
- Set redirect URI: `http://localhost:3000/oauth2callback`
- Download or copy your client ID and secret

### 3. Configure Environment Variables
Create a `.env` file in the project root:
```
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
PORT=3000
```

### 4. Run the Server
```sh
node index.js
```

## Usage
1. Visit [http://localhost:3000/auth](http://localhost:3000/auth) to authenticate with Google.
2. After authenticating, your token is saved and associated with your Google email.
3. For all API requests, include your email in the `X-User-Email` header:
   - Example: `X-User-Email: youremail@gmail.com`

## API Endpoints

### `GET /events`
Returns a list of upcoming events for the authenticated user:
```
[
  {
    "id": "...",
    "title": "Meeting with John",
    "start": "2025-07-25T15:00:00Z",
    "end": "2025-07-25T16:00:00Z",
    "durationMinutes": 60,
    "location": "Google Meet",
    "attendees": ["john@example.com", "you@example.com"]
  },
  ...
]
```

### `GET /events/:id`
Returns details for a single event by ID (for the authenticated user).

### `GET /events/summary`
Returns a summary of upcoming events (for the authenticated user):
```
{
  "totalEvents": 12,
  "totalHours": 6,
  "firstEventStart": "2025-07-25T10:00:00Z",
  "lastEventEnd": "2025-07-25T20:00:00Z"
}
```

## Notes
- Caching: `/events` and `/events/summary` are cached for 1 minute per user.
- Token is stored persistently in `db.json` (per user).
- All API requests require the `X-User-Email` header after authentication.
- Security: helmet and express-rate-limit are enabled by default.

## License
MIT 