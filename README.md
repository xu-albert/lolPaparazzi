# LoL Paparazzi 🎮

A Discord bot that tracks League of Legends ranked solo/duo queue gaming sessions with comprehensive match analytics and persistent data storage.

## Features

- 🎯 **Session-based tracking** - Smart notifications for session start/end with complete game analytics
- 🏆 **Ranked Solo/Duo only** - Focuses on competitive ranked games (queue ID 420)
- ⏰ **Smart timing** - 15-minute timeout with accurate session duration calculation
- 📊 **Comprehensive analytics** - LP tracking, champion statistics, KDA analysis, and session summaries
- 🎮 **Live game detection** - Real-time status with champion artwork and game timing
- 💾 **Full persistence** - PostgreSQL database ensures zero data loss across deployments
- 🔄 **Intelligent polling** - Adaptive intervals (3min idle, 5min during sessions)
- 📈 **Positive feedback** - Only shows LP gains to encourage players
- 🎭 **Champion artwork** - Visual displays using Riot's Data Dragon API
- 👥 **Role management** - Users can opt-in/out of session notifications

## How It Works

The bot monitors players and provides intelligent notifications:

- **Session Start**: When a player begins their first ranked game (with role ping for subscribers)
- **Post-Game**: Match results with champion artwork, KDA, CS, LP changes (wins only)
- **Session End**: Comprehensive summary with duration, W/L record, LP delta, and champion stats

Sessions span multiple games with accurate timing based on actual gameplay, not detection delays.

## Prerequisites

Before setting up the bot, you'll need:

1. **Discord Bot Token** - Create a bot application at [Discord Developer Portal](https://discord.com/developers/applications)
2. **Riot Games API Key** - Get from [Riot Developer Portal](https://developer.riotgames.com/)
3. **PostgreSQL Database** - For persistent data storage (recommended for production)
4. **Node.js** - Version 18 or higher

## Quick Start

### 1. Get Your API Keys

**Discord Bot Token:**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create "New Application" → name it "LoL Paparazzi"
3. Go to "Bot" → "Reset Token" → copy the token
4. Enable "Message Content Intent" under "Privileged Gateway Intents"
5. Set permissions: "Send Messages", "Use Slash Commands", "Manage Roles"

**Riot Games API Key:**
1. Go to [Riot Developer Portal](https://developer.riotgames.com/)
2. Sign in with your League account
3. Copy your "Personal API Key" (regenerates every 24 hours for development)
4. For production, apply for a "Production API Key"

### 2. Database Setup

**Option A: Managed Database (Recommended)**
- Use cloud providers like Railway, Neon, Supabase, or AWS RDS
- Most provide free tiers sufficient for small Discord servers
- Get the `DATABASE_URL` connection string

**Option B: Local Development**
```bash
# Install PostgreSQL locally
# macOS with Homebrew:
brew install postgresql
brew services start postgresql

# Create database
createdb lolpaparazzi

# Set DATABASE_URL in .env:
# DATABASE_URL=postgresql://username:password@localhost:5432/lolpaparazzi
```

**Option C: Docker (Development)**
```bash
# Start PostgreSQL container
docker run --name lolpaparazzi-db -e POSTGRES_PASSWORD=password -e POSTGRES_DB=lolpaparazzi -p 5432:5432 -d postgres:15

# Set DATABASE_URL in .env:
# DATABASE_URL=postgresql://postgres:password@localhost:5432/lolpaparazzi
```

### 3. Installation

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

### 4. Configure Environment Variables

Edit your `.env` file:

```env
# Required
DISCORD_TOKEN=your_discord_bot_token_here
RIOT_API_KEY=your_riot_games_api_key_here

# Optional - Database (recommended for production)
DATABASE_URL=postgresql://username:password@host:5432/database_name

# Optional - Configuration
NODE_ENV=production
```

**Environment Variable Details:**
- `DISCORD_TOKEN` - Your Discord bot token (required)
- `RIOT_API_KEY` - Your Riot Games API key (required) 
- `DATABASE_URL` - PostgreSQL connection string (optional, but recommended)
- `NODE_ENV` - Set to "production" for deployment (optional)

### 5. Add Bot to Discord

1. In Discord Developer Portal → "OAuth2" → "URL Generator"
2. Check "bot" and "applications.commands"
3. Under "Bot Permissions" check:
   - Send Messages
   - Use Slash Commands
   - Manage Roles (for notification system)
4. Copy the generated URL and open it to invite the bot to your server

### 6. Run the Bot

```bash
# Development (with auto-restart)
npm run dev

# Production
npm start
```

### 7. Set Up Tracking

Once your bot is running and in your Discord server:

1. Go to the Discord channel where you want notifications
2. Use the setup command: `/setup GameName#TAG`
   - Example: `/setup Melvinbung#NA1`
   - Include the # and tag (NA1, EUW1, KR, etc.)
3. Users can join notifications: `/join` (creates/assigns Paparazzi role)
4. Users can leave notifications: `/leave` (removes Paparazzi role)

**Finding your Riot ID:**
- Format: `GameName#TAG` 
- Check op.gg URLs: `op.gg/lol/summoners/na/GameName-TAG`
- In-game: Settings → Account → Riot ID

## Deployment Options

### Railway (Recommended - Easy)

Railway provides free hosting with automatic PostgreSQL database:

**Step 1: Push to GitHub**
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/your-username/lolPaparazzi.git
git branch -M main
git push -u origin main
```

**Step 2: Deploy**
1. Go to [railway.app](https://railway.app) and sign up with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your repository
4. Add a PostgreSQL database: "New" → "Database" → "PostgreSQL"
5. Add environment variables:
   - `DISCORD_TOKEN`: Your Discord bot token
   - `RIOT_API_KEY`: Your Riot API key
   - `DATABASE_URL`: Automatically set by Railway
6. Deploy and your bot will be live!

### Other Cloud Providers

**Heroku:**
- Add Heroku Postgres addon
- Set environment variables in dashboard
- Deploy via Git or GitHub integration

**DigitalOcean App Platform:**
- Create managed PostgreSQL database
- Deploy from GitHub with environment variables

**AWS/Google Cloud:**
- Use RDS/Cloud SQL for PostgreSQL
- Deploy to ECS/Cloud Run with environment variables

**VPS (Advanced):**
- Install PostgreSQL and Node.js
- Use PM2 for process management: `pm2 start npm --name "lolpaparazzi" -- start`
- Set up reverse proxy with nginx (optional)

### Docker Deployment

```bash
# Build and run with docker-compose
docker-compose up -d

# Or build manually
docker build -t lolpaparazzi .
docker run -d --name lolpaparazzi \
  -e DISCORD_TOKEN=your_token \
  -e RIOT_API_KEY=your_key \
  -e DATABASE_URL=your_db_url \
  lolpaparazzi
```

## Commands

### Basic Commands
- `/setup <GameName#TAG>` - Set up tracking for a player in the current channel
- `/stop` - Stop tracking in the current channel
- `/info` - Show current tracking status, session info, and live game data
- `/status <summoner>` - Check if someone is currently playing (any summoner)

### Notification Management
- `/join` - Get the Paparazzi role to receive session notifications
- `/leave` - Remove the Paparazzi role to stop notifications

## Configuration

### Session Settings
Edit `src/tracker.js` for session behavior:
```javascript
// Session timeout (minutes of inactivity before session ends)
this.sessionTimeoutMinutes = 15;

// Polling intervals
this.normalPollingInterval = '*/3 * * * *'; // Every 3 minutes when idle
this.inGamePollingInterval = '*/5 * * * *'; // Every 5 minutes during sessions
```

### Regional Settings
Edit `src/riotApi.js` for different regions:
```javascript
// Change region endpoint
this.baseURL = 'https://na1.api.riotgames.com/lol'; // na1, euw1, kr, etc.

// Change regional cluster for Account API
this.accountBaseURL = 'https://americas.api.riotgames.com/riot/account/v1'; // americas, asia, europe
```

**Supported Regions:**
- **Americas**: na1, br1, la1, la2, oc1
- **Asia**: kr, jp1, tw2, th2, sg2, ph2, vn2
- **Europe**: euw1, eun1, tr1, ru

## Database Schema

The bot automatically creates these tables:

**player_tracking** - Main session tracking
**session_games** - Individual game records with full match details
**session_stats** - Aggregated session statistics
**pending_match_analysis** - Queue for post-game analysis

No manual database setup required - schema is created automatically on first run.

## API Rate Limits & Monitoring

**Personal API Key Limits:**
- 100 requests per 2 minutes
- 20,000 requests per day
- Bot uses ~4-6 requests per check
- Daily usage: ~2,000-3,000 requests

**Production API Key** (recommended for public bots):
- Apply at [Riot Developer Portal](https://developer.riotgames.com/)
- Much higher rate limits
- Required for commercial use

**Monitoring Usage:**
```bash
# View logs for API calls
npm run logs

# Railway: View logs in dashboard
# Heroku: heroku logs --tail -a your-app
```

## Advanced Features

### Data Dragon Integration
- Automatic champion data updates
- Future-proof against new champion releases
- Champion artwork in notifications and commands

### Persistent Queue System
- Handles match analysis delays
- Survives bot restarts
- Retry logic for failed analyses

### Session Analytics
- Accurate gameplay duration calculation
- LP delta tracking with positive-only feedback
- Champion performance statistics
- Best/worst game tracking

## Troubleshooting

### Common Issues

**Bot not responding to commands:**
```bash
# Check bot permissions in Discord server
# Verify DISCORD_TOKEN is correct
# Check application.commands scope was granted
```

**Database connection errors:**
```bash
# Verify DATABASE_URL format
# Check database server status
# Ensure database exists and is accessible
```

**"Summoner not found" errors:**
```bash
# Verify Riot ID format: GameName#TAG
# Check region settings match summoner's region
# Ensure API key is valid and not expired
```

**Session tracking not working:**
```bash
# Check RIOT_API_KEY is valid
# Verify player is playing ranked solo/duo (queue ID 420)
# Check logs for API rate limit errors
```

### Logs & Debugging

**View logs:**
```bash
# Local development
npm run dev  # Shows real-time logs

# Production logs
pm2 logs lolpaparazzi  # If using PM2
docker logs lolpaparazzi  # If using Docker
```

**Common log messages:**
- `✅ Database connection successful` - PostgreSQL connected
- `📊 Existing tracking records: X` - Data restored from database
- `🔄 Restored tracking: Player in channel` - Session restored after restart
- `⚠️ DATABASE_URL not found` - Running without persistence

### Performance Optimization

**For high-traffic servers:**
1. Use production Riot API key
2. Implement Redis caching (optional)
3. Scale database resources
4. Monitor memory usage and optimize polling

**Database maintenance:**
```sql
-- Clean old session data (optional, run periodically)
DELETE FROM session_games WHERE created_at < NOW() - INTERVAL '30 days';
DELETE FROM session_stats WHERE updated_at < NOW() - INTERVAL '30 days';
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Setup

```bash
# Install development dependencies
npm install

# Run tests (if available)
npm test

# Lint code
npm run lint

# Format code
npm run format
```

## Roadmap

- [ ] Multi-player tracking support
- [ ] Web dashboard for statistics
- [ ] Advanced analytics and trends
- [ ] Support for other game modes
- [ ] Integration with more LoL APIs

## License

MIT License - feel free to use and modify!

## Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/lolPaparazzi/issues)
- **Documentation**: Check this README and inline code comments
- **Community**: Join discussions in GitHub Discussions

---

**Made with ❤️ for the League of Legends community**

*Last updated: [Current Date] - Keep documentation current with new features*