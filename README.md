# Facebook Automation

> A full-stack Facebook automation system with a dockerized Playwright-based backend service, BullMQ job queue, Redis session storage, and an n8n community node.

**Cookie-based authentication only** — no email/password login. Export your Facebook cookies once, and the system handles session persistence, auto-refresh, and multi-account management.

---

## Architecture

```
┌──────────────┐     REST API      ┌──────────────────┐
│   n8n Node   │ ◄──────────────► │  Docker Service   │
│  (Community) │                   │  (Fastify + API)  │
└──────────────┘                   └────────┬─────────┘
                                            │
                                   ┌────────▼─────────┐
                                   │    BullMQ Queue   │
                                   │  (Job Processing) │
                                   └────────┬─────────┘
                                            │
                          ┌─────────────────┼─────────────────┐
                          │                 │                 │
                  ┌───────▼──────┐  ┌──────▼───────┐  ┌─────▼──────┐
                  │  Post Scraper │  │Member Scraper│  │Auto Message│
                  └───────┬──────┘  └──────┬───────┘  └─────┬──────┘
                          │                │                 │
                          └────────────────┼─────────────────┘
                                           │
                                  ┌────────▼─────────┐
                                  │   Playwright +    │
                                  │   Chromium (HQ)   │
                                  └────────┬─────────┘
                                           │
                                  ┌────────▼─────────┐
                                  │  Session Manager  │
                                  │  (Redis + AES)    │
                                  └──────────────────┘
```

---

## Features

- **3 Operations**: Group Post Scraper, Group Member Scraper, Auto Message
- **Cookie-based auth**: Chrome Export, EditThisCookie, Playwright State, Puppeteer Array
- **Session Management**: AES-256-GCM encrypted, Redis-backed, auto-refresh, multi-account
- **Anti-detection**: Stealth scripts, human-like delays, random scroll, UA rotation
- **Job Queue**: BullMQ with priorities, retries, delayed jobs, concurrency limits
- **API**: Fastify with Swagger/OpenAPI docs, JWT + API Key auth, rate limiting
- **Docker**: Multi-stage build, Chromium included, healthchecks, persistent volumes
- **n8n Node**: Full community node with dropdown operations, typed outputs, job polling
- **Error Handling**: Screenshots + HTML dumps on failure, structured error codes
- **Logging**: Pino with cookie redaction, request/response logging

---

## Project Structure

```
facebooknode/
├── shared-types/           # Shared TypeScript interfaces
│   ├── src/index.ts
│   ├── package.json
│   └── tsconfig.json
├── docker-service/         # Backend service
│   ├── src/
│   │   ├── index.ts              # Entry point
│   │   ├── app.ts                # Fastify app setup
│   │   ├── config/index.ts       # Env validation (Zod)
│   │   ├── errors/index.ts       # Error classes
│   │   ├── infrastructure/
│   │   │   └── redis.ts          # Redis client
│   │   ├── middleware/
│   │   │   └── auth.ts           # API Key / JWT auth
│   │   ├── operations/
│   │   │   ├── group-post-scraper.ts
│   │   │   ├── group-member-scraper.ts
│   │   │   └── auto-message.ts
│   │   ├── queue/
│   │   │   └── queue-manager.ts  # BullMQ setup
│   │   ├── routes/
│   │   │   ├── scrape.ts
│   │   │   ├── message.ts
│   │   │   ├── session.ts
│   │   │   ├── jobs.ts
│   │   │   └── health.ts
│   │   ├── services/
│   │   │   ├── session-manager.ts
│   │   │   └── browser-service.ts
│   │   └── utils/
│   │       ├── logger.ts
│   │       ├── encryption.ts
│   │       ├── cookie-parser.ts
│   │       └── helpers.ts
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
├── n8n-node/               # n8n Community Node
│   ├── src/
│   │   ├── index.ts
│   │   ├── credentials/
│   │   │   └── FacebookAutomationApi.credentials.ts
│   │   └── nodes/
│   │       └── FacebookAutomation/
│   │           ├── FacebookAutomation.node.ts
│   │           └── facebook.svg
│   ├── gulpfile.js
│   ├── package.json
│   └── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── .gitignore
└── README.md
```

---

## Quick Start

### 1. Clone & configure

```bash
git clone https://github.com/your-repo/facebook-automation.git
cd facebook-automation
cp .env.example .env
# Edit .env with your secrets
```

### 2. Start with Docker Compose

```bash
docker compose up -d
```

The service starts at `http://localhost:3000`.

- API docs: `http://localhost:3000/docs`
- Health check: `http://localhost:3000/health`

### 3. Import your Facebook session

Export cookies from your logged-in Facebook session using a browser extension like [EditThisCookie](https://www.editthiscookie.com/) or the browser DevTools.

```bash
curl -X POST http://localhost:3000/api/session/import \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionName": "my-account",
    "cookies": [{"name":"c_user","value":"...","domain":".facebook.com","path":"/","expires":-1,"httpOnly":false,"secure":true}],
    "format": "json"
  }'
```

### 4. Run an operation

```bash
# Scrape posts
curl -X POST http://localhost:3000/api/scrape/posts \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionName": "my-account",
    "groups": ["https://www.facebook.com/groups/123456"]
  }'

# Check job status
curl http://localhost:3000/api/job/JOB_ID \
  -H "Authorization: Bearer your-api-key"
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/scrape/posts` | Scrape posts from Facebook groups |
| `POST` | `/api/scrape/members` | Scrape members from Facebook groups |
| `POST` | `/api/message/send` | Send a message to a Facebook user |
| `POST` | `/api/session/import` | Import session cookies |
| `GET` | `/api/session/status?sessionName=x` | Get session status |
| `POST` | `/api/session/refresh` | Refresh a session |
| `GET` | `/api/session/export?sessionName=x` | Export session cookies |
| `GET` | `/api/session/list` | List all sessions |
| `GET` | `/api/job/:jobId` | Get job status |
| `GET` | `/api/queue/stats` | Get queue statistics |
| `GET` | `/health` | Health check |
| `GET` | `/docs` | Swagger UI |

---

## Authentication

All `/api/*` endpoints require authentication via:

- **API Key**: `Authorization: Bearer <your-api-key>` or `Authorization: ApiKey <your-api-key>`
- **JWT**: `Authorization: Bearer <jwt-token>`

---

## Cookie Formats

The system supports importing cookies in these formats:

| Format | Description |
|--------|-------------|
| `json` | Auto-detect format |
| `chrome-export` | Chrome cookie export (JSON array) |
| `editthiscookie` | EditThisCookie browser extension export |
| `playwright-state` | Playwright `storageState()` output |
| `puppeteer-array` | Puppeteer `cookies()` output |

---

## n8n Integration

### Install the community node

```bash
cd n8n-node
npm install
npm run build
# Link or copy to your n8n custom nodes directory
```

### Configure credentials

In n8n, add **Facebook Automation API** credentials:

1. **API URL**: `http://facebook-automation:3000` (Docker network) or `http://localhost:3000`
2. **API Key**: Your configured API key
3. **Session Name**: A name for this account (e.g., `my-account`)
4. **Facebook Cookies JSON**: Paste your exported cookies
5. **Proxy** (optional): Proxy URL
6. **User Agent** (optional): Custom UA string

### Operations

- **Group Post Scraper**: Enter group URLs (one per line), optional timestamp filter
- **Group Member Scraper**: Enter group URLs (one per line), set max members
- **Auto Message**: Enter username and message text

---

## Example n8n Workflow

```json
{
  "nodes": [
    {
      "parameters": {
        "operation": "groupPostScraper",
        "groups": "https://www.facebook.com/groups/123456789",
        "maxPosts": 20,
        "options": {
          "waitForCompletion": true,
          "pollInterval": 5000
        }
      },
      "name": "Facebook Automation",
      "type": "n8n-nodes-facebook-automation.facebookAutomation",
      "typeVersion": 1,
      "position": [450, 300],
      "credentials": {
        "facebookAutomationApi": {
          "id": "1",
          "name": "Facebook Automation API"
        }
      }
    }
  ]
}
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `HOST` | `0.0.0.0` | Server host |
| `API_KEYS` | — | Comma-separated API keys |
| `JWT_SECRET` | — | JWT signing secret (32+ chars) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `ENCRYPTION_KEY` | — | AES encryption key (32+ chars) |
| `BROWSER_HEADLESS` | `true` | Run Chromium headless |
| `MAX_CONCURRENCY` | `2` | Max concurrent browser jobs |
| `DEFAULT_TIMEOUT` | `60000` | Default operation timeout (ms) |
| `SCREENSHOT_ON_ERROR` | `true` | Capture screenshots on error |
| `HTML_DUMP_ON_ERROR` | `true` | Dump HTML on error |
| `LOG_LEVEL` | `info` | Pino log level |
| `WEBHOOK_URL` | — | Webhook URL for events |
| `DATA_DIR` | `/data` | Persistent data directory |

---

## Security

- Cookies are encrypted at rest with AES-256-GCM (PBKDF2 key derivation)
- Cookies are **never** logged (Pino redaction)
- Sessions stored in Redis with configurable TTL
- API Key and JWT authentication
- Rate limiting (100 req/min default)
- Non-root Docker user
- Helmet security headers

---

## Development

```bash
# Build shared types
cd shared-types && npm install && npm run build && cd ..

# Run docker service locally
cd docker-service && npm install && npm run dev

# Build n8n node
cd n8n-node && npm install && npm run build
```

---

## License

MIT
