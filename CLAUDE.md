# LoL Paparazzi Development Notes

## Current Status
- ✅ Core bot functionality complete with PostgreSQL persistence
- ✅ Session-based tracking (start/end notifications)
- ✅ Riot ID support with Account API integration  
- ✅ Smart polling: 3min idle, 5min during sessions
- ✅ Deployed on Railway with auto-redeploys
- ✅ Fixed summoner ID issue - now uses PUUID for rank lookups
- ✅ Role ping system with /join and /leave commands
- ✅ **Comprehensive betting system with deployment resistance**
- ✅ **Interactive betting panels with 4-minute countdown timers**
- ✅ **Champion portraits and visual enhancements**
- ✅ **User credit management with daily claims**
- ✅ **Bet updates allowed until deadline**
- ✅ **Duplicate panel prevention across deployments**

## Betting System Features
- **Real-time betting**: 4-minute windows with Discord dynamic timers
- **Team analysis**: Shows champion winrates, tracked player stats
- **Flexible betting**: Users can change bets until deadline expires
- **Credit system**: 100 daily credits, betting doubles or nothing
- **Visual design**: Champion portraits, team layouts, clear messaging
- **Production ready**: Deploy-resistant, no duplicate panels, proper error handling

## Pending Todo Items

### 1. Enhanced Betting Features
- Add game duration check to prevent betting on games >5 minutes old
- Implement betting statistics and leaderboards
- Add betting history for users

### 2. Session Analytics
- Add win/loss summary after each session ends
- Track LP gain/loss for each session
- Display session statistics (games played, duration, performance)

### 3. Detailed Player Information  
- Show LP, current rank, recent winrate
- Display best/most played champions
- Performance metrics and trends

### 4. Advanced Features
- Implement multiple player tracking capability
- Track different players in different channels
- Add betting on multiple games simultaneously

## Technical Notes
- **Database**: PostgreSQL on Railway with persistent storage
- **APIs**: Riot Account API, Summoner API, Spectator API v5, Data Dragon for champion images
- **Game Tracking**: Only ranked solo/duo games (queue ID 420)
- **Session Logic**: 15 minutes of inactivity timeout, smart polling intervals
- **Betting System**: 4-minute betting windows, deployment-resistant panel tracking
- **Bot Permissions**: Manage Roles (for Paparazzi role creation/assignment)
- **Data Persistence**: All betting panels, user credits, session data persisted in PostgreSQL

## Database Admin Instructions

### Editing User Credits (Railway Dashboard)
1. Go to Railway project → PostgreSQL service → Data tab
2. **View all users**: `SELECT user_id, guild_id, balance, total_winnings, total_losses FROM user_credits ORDER BY balance DESC;`
3. **Set specific user's credits**: `UPDATE user_credits SET balance = 500 WHERE user_id = 'DISCORD_USER_ID_HERE';`
4. **Add/remove credits**: `UPDATE user_credits SET balance = balance + 250 WHERE user_id = 'DISCORD_USER_ID_HERE';`
5. **Find user IDs**: Enable Discord Developer Mode → Right-click user → Copy User ID

### Database Tables
- `user_credits`: User balances and betting statistics
- `active_bets`: Current bets on ongoing games  
- `betting_panels`: Tracks sent panels to prevent duplicates
- `bet_history`: Historical betting records
- `player_tracking`: Session and game tracking data
- `session_games`: Individual game results and stats

## Development Guidelines
- Continuously check if variables or data is persisted correctly with each new feature
- Keep README.md documentation current and comprehensive for developers
- Update README.md whenever new features, commands, or configuration options are added
- Test betting functionality thoroughly with deployment scenarios
- Monitor database for proper cleanup of old betting panels