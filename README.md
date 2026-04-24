# LoL Paparazzi

A Discord bot that tracks your friends' League of Legends ranked games and progress, and lets you bet on the outcome.

## Screenshots

| Predictions | Victory | Defeat | Daily Summary |
|:-:|:-:|:-:|:-:|
| ![Predictions](screenshots/predictions.png) | ![Victory](screenshots/victory.png) | ![Defeat](screenshots/defeat.png) | ![Daily Summary](screenshots/daily-summary.png) |

## Features

- Detects when a tracked player starts a ranked game and notifies the server
- Prediction system where members can bet on win/loss with a leaderboard
- Live game analysis with team compositions and champion winrates
- Daily summaries at midnight with W/L record, LP changes, and champion stats

## How it's built

Node.js bot using Discord.js and the Riot Games API. PostgreSQL for persistent storage of tracking data, predictions, and leaderboards. Polls the Riot API on a 3-minute interval to detect games.

Intended to be deployed on [Railway](https://railway.com) for anyone to use.

## Getting started

### Prerequisites

- Node.js 18+
- PostgreSQL database (local or hosted, e.g. [Railway](https://railway.com) or [Neon](https://neon.tech)). Tables are created automatically on first run.
- Discord bot token — create one at the [Discord Developer Portal](https://discord.com/developers/applications)
- Riot Games API key — get one from the [Riot Developer Portal](https://developer.riotgames.com/)

### Setup

```bash
git clone https://github.com/xu-albert/lolPaparazzi.git
cd lolPaparazzi
npm install
cp .env.example .env
```

Fill in your `.env`:

```env
DISCORD_TOKEN=your_discord_bot_token
RIOT_API_KEY=your_riot_api_key
DATABASE_URL=postgresql://username:password@host:5432/database_name
```

### Add the bot to your server

Follow Discord's [official guide](https://discord.com/developers/docs/quick-start/getting-started#installing-your-app) to generate an invite link. The bot needs the `bot` and `applications.commands` scopes, and Send Messages, Use Slash Commands, and Manage Roles permissions.

### Run

```bash
npm start
```

### Discord commands

- `/setup GameName#TAG` — start tracking a player in the current channel
- `/stop` — stop tracking
- `/join` / `/leave` — opt in or out of notifications. The bot creates a Paparazzi role in the server and pings it when a tracked player starts a game.
- `/info` — show current tracking status
