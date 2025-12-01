# App Reply Bot

<p align="center">
  <img src="assets/avatar.png" alt="App Reply Bot avatar" width="140">
</p>

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18+-43853d?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-229ED9?logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![Supabase](https://img.shields.io/badge/Supabase-Database-3FCF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)

> AI-powered Telegram bot that monitors App Store and Play Store reviews, drafts contextual replies, and lets you approve or tweak them before posting. Built to avoid opening the store web UI or mobile app just to type replies by hand.

## Table of Contents
- [Why App Reply Bot](#why-app-reply-bot)
- [How It Works](#how-it-works)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Bot Commands](#bot-commands)
- [Project Structure](#project-structure)
- [Database Schema](#database-schema)
- [Development](#development)
- [Deployment Notes](#deployment-notes)
- [License](#license)

## Why App Reply Bot
- 🔍 **Always-on monitoring**: Polls App Store and Play Store every 15 minutes to catch fresh reviews.
- 🤖 **Contextual AI replies**: Generates tone-aware responses via OpenRouter with your brand voice in mind.
- ✅ **Human-in-the-loop**: Approve, edit, regenerate, or reject before anything is posted publicly.
- 📱 **Multi-app, multi-account**: Connect multiple developer accounts and manage all apps from one Telegram bot.
- ⚡ **Optional auto-approve**: Fast-track positive reviews while keeping manual control for critical feedback.

## How It Works
1. Connect App Store Connect and/or Google Play accounts via Telegram.
2. Bot discovers your apps and starts polling for new reviews on a schedule (default: every 15 minutes).
3. New reviews trigger a Telegram message with the review details and an AI-drafted response.
4. You choose to **Approve**, **Edit**, **Regenerate**, or **Reject**—approved replies are posted automatically.

## Quickstart

### Prerequisites
- Node.js 18+
- Supabase project (for storage and auth)
- Telegram Bot Token (from [@BotFather](https://t.me/BotFather))
- OpenRouter API key
- App Store Connect API key (`.p8`) for iOS apps
- Google Play Console Service Account JSON for Android apps

### 1) Install dependencies
```bash
npm install
```

### 2) Configure environment
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

### 3) Prepare Supabase schema
Generate the SQL locally, then run it in Supabase SQL Editor:
```bash
npm run prepare-migrations
# Open supabase/migrations/schema.sql in the Supabase SQL Editor and execute it
```

### 4) Run the bot
Development (watch mode):
```bash
npm run dev
```

Production build:
```bash
npm run build
npm start
```

## Configuration
Set these in `.env`:

```env
# Telegram Bot
TELEGRAM_BOT_TOKEN=your_bot_token

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key

# LLM Processor
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
SYSTEM_PROMPT="You are a professional customer support representative responding to store reviews.\nYour responses should:\n- Be warm, professional, and empathetic\n- Thank users for their feedback\n- Address specific concerns mentioned in the review\n- For negative reviews: apologize for any inconvenience and offer to help resolve issues\n- For positive reviews: express genuine gratitude\n- When appropriate, mention that the team values their feedback\n- Avoid making promises you can't keep\n- Never be defensive or dismissive\n- Sign off with a friendly closing\n- Respond in the same language the review was written in\n\nIMPORTANT CONSTRAINTS:\n- Maximum response length: ${maxLength} characters\n- Detect the primary language from the entire review (ignore greetings in other languages) and respond in that language\n- Keep responses concise but meaningful\n- Do not use markdown formatting\n- Write in a conversational, natural tone"

# Polling interval in minutes (default: 15)
POLL_INTERVAL_MINUTES=15

# Debug mode (optional)
DEBUG=true
```

`OPENROUTER_MODEL` is optional; `SYSTEM_PROMPT` is required. Use `\n` to include newlines in `SYSTEM_PROMPT`. `${maxLength}` inside `SYSTEM_PROMPT` is replaced at runtime. Custom instructions set inside the bot are appended to the system prompt for each request.

> Keep credential files (App Store `.p8`, Google Play service account JSON) secure and off version control.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Register and get started |
| `/account` | Connect a developer account (App Store Connect / Google Play) |
| `/accounts` | View and manage connected accounts |
| `/apps` | View all discovered apps |
| `/preferences` | Configure auto-approve and notifications |
| `/review` | Walk through pending reviews one by one |
| `/poll` | Fetch new reviews now |
| `/stats` | View review statistics |
| `/help` | Show help |
| `/cancel` | Cancel current operation |

## Project Structure

```
src/
├── bot.ts                  # Entry point, bot setup
├── scheduler.ts            # Cron-based polling
├── scenes/
│   ├── accountScene.ts     # Account connection wizard
│   └── preferencesScene.ts # Preferences wizard
├── services/
│   ├── supabase.ts         # Database operations
│   ├── credentialValidator.ts # Credential file validation
│   ├── appStoreClient.ts   # App Store Connect API
│   ├── playStoreClient.ts  # Google Play API
│   ├── playStoreScraper.ts # Play Store scraping
│   └── llmService.ts       # OpenRouter AI
├── handlers/
│   ├── commands.ts         # Command handlers
│   └── reviewHandler.ts    # Review workflow
└── utils/
    └── logger.ts           # Logging utilities
```

## Database Schema

The bot uses a `reviews_bot` schema with the following tables:

| Table | Purpose |
|-------|---------|
| `users` | Telegram users who use the bot |
| `user_preferences` | Per-user settings (auto-approve, notifications) |
| `accounts` | Developer accounts with credentials |
| `apps` | Apps linked to accounts |
| `reviews` | Fetched reviews from stores |
| `responses` | AI-generated and final responses |
| `telegram_messages` | Message tracking for editing |

## Development
- `npm run dev` — start bot in watch mode
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run compiled bot
- `npm run typecheck` — type-check without emitting
- `npm run prepare-migrations` — regenerate Supabase SQL

Enable verbose logging with:
```bash
DEBUG=true npm run dev
```

## Deployment Notes
- Run the bot under a process manager (e.g., `pm2`, `systemd`) and configure it with your `.env`.
- Keep polling intervals reasonable to respect App Store and Play Store rate limits.
- Securely store API keys and credential files.

## License

MIT
