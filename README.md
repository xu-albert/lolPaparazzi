# LoL Paparazzi 🎮

A Discord bot that tracks League of Legends ranked solo/duo queue gaming sessions and sends smart notifications to your Discord channel.

## Features

- 🎯 **Session-based tracking** - Only notifies on session start/end, not individual games
- 🏆 **Ranked Solo/Duo only** - Ignores other game modes (ARAM, normals, etc.)
- ⏰ **Smart timing** - 15-minute timeout between games to define session end
- 📊 **Session stats** - Shows duration and games played per session
- 🔄 **API-friendly** - Polls every 3 minutes when idle, 5 minutes during sessions
- ⚡ **Easy setup** - Configure via Discord commands, no complex environment setup
- 💾 **Persistent tracking** - Uses PostgreSQL database to remember tracking settings across deployments

## How It Works

The bot monitors a single player and sends Discord notifications for:

- **Session Start**: When the player begins their first ranked game
- **Session End**: After 15+ minutes of no ranked games

Sessions can span multiple games and hours. You'll only get 2 notifications per gaming session instead of spam for every individual game.

## Quick Start

### 1. Get Your API Keys

**Discord Bot Token:**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create "New Application" → name it "LoL Paparazzi"
3. Go to "Bot" → "Reset Token" → copy the token
4. Enable "Message Content Intent" under "Privileged Gateway Intents"

**Riot Games API Key:**
1. Go to [Riot Developer Portal](https://developer.riotgames.com/)
2. Sign in with your League account
3. Copy your "Personal API Key" (regenerates every 24 hours for development)


### 2. Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/lolPaparazzi.git
cd lolPaparazzi

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your actual values
```

### 3. Configure Environment Variables

Edit your `.env` file:

```env
DISCORD_TOKEN=your_discord_bot_token_here
RIOT_API_KEY=your_riot_games_api_key_here
```

### 4. Add Bot to Discord

1. In Discord Developer Portal → "OAuth2" → "URL Generator"
2. Check "bot" and "applications.commands"
3. Under "Bot Permissions" check "Send Messages" and "Use Slash Commands"
4. Copy the generated URL and open it to invite the bot to your server

### 5. Run the Bot

```bash
# Development (with auto-restart)
npm run dev

# Production
npm start
```

### 6. Set Up Tracking

Once your bot is running and in your Discord server:

1. Go to the Discord channel where you want notifications
2. Use the setup command with your full Riot ID: `/setup GameName#TAG`
   - Example: `/setup Melvinbung#NA1`
   - You must include the # and tag (NA1, EUW1, KR, etc.)
3. The bot will confirm tracking is active and show your current rank
4. That's it! You'll now get session notifications in that channel

**Finding your Riot ID:**
- Your Riot ID is in the format `GameName#TAG` 
- You can find it on op.gg URLs: `op.gg/lol/summoners/na/GameName-TAG`
- In-game: Settings → Account → Riot ID

## Deployment on Railway (Free)

### Step 1: Push to GitHub
```bash
# Initialize git repository
git init
git add .
git commit -m "Initial commit"

# Create GitHub repo and push (replace with your username)
git remote add origin https://github.com/your-username/lolPaparazzi.git
git branch -M main
git push -u origin main
```

### Step 2: Deploy on Railway
1. Go to [railway.app](https://railway.app) and sign up with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your `lolPaparazzi` repository
4. Add environment variables:
   - Click "Variables" tab
   - Add only 2 variables: `DISCORD_TOKEN` and `RIOT_API_KEY`
5. Click "Deploy" - your bot will be live in ~2 minutes!
6. Use `/setup <summoner>` in Discord to start tracking

Railway automatically:
- Builds and deploys your Node.js app
- Keeps it running 24/7
- Restarts on crashes
- Provides logs and monitoring

## Commands

- `/setup <GameName#TAG>` - Set up tracking for a player in the current channel (e.g., `/setup Melvinbung#NA1`)
- `/stop` - Stop tracking in the current channel
- `/info` - Show current tracking status and session info
- `/status <summoner>` - Check if someone is currently playing (any summoner)

## Configuration

### Session Timeout
Sessions end after 15 minutes of no ranked games. To change this, edit `src/tracker.js`:
```javascript
this.sessionTimeoutMinutes = 15; // Change this value
```

### Polling Frequency  
Bot checks every 2 minutes. To change, edit the cron schedule in `src/tracker.js`:
```javascript
this.cronJob = cron.schedule('*/2 * * * *', async () => { // Every 2 minutes
```

### Supported Regions
Currently set to NA1. To change regions, edit `src/riotApi.js`:
```javascript
this.baseURL = 'https://na1.api.riotgames.com/lol'; // Change na1 to your region
```

## API Rate Limits

- **Personal API Key**: 100 requests per 2 minutes
- **Bot polling**: Every 2 minutes = ~3 requests per check
- **Daily usage**: ~2,160 requests (well within limits)

For production/multiple users, get a production API key from Riot.

## Troubleshooting

**Bot not responding:**
- Check Railway logs for errors
- Verify all environment variables are set correctly
- Ensure Discord bot has proper permissions in your server

**"Summoner not found" errors:**
- Double-check summoner name spelling and region
- Summoner names are case-sensitive

**API key expired:**
- Personal API keys reset daily - update in Railway variables
- Consider getting a production key for permanent deployment

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - feel free to use and modify!

---

**Made with ❤️ for the League of Legends community**