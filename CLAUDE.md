# LoL Paparazzi Development Notes

## Current Status
- ✅ Core bot functionality complete with PostgreSQL persistence
- ✅ **Daily tracking system** (replaced session-based tracking to reduce spam)
- ✅ Riot ID support with Account API integration  
- ✅ Smart polling: 3min intervals for consistent game detection
- ✅ Deployed on Railway with auto-redeploys
- ✅ Fixed summoner ID issue - now uses PUUID for rank lookups
- ✅ Role ping system with /join and /leave commands
- ✅ **MAJOR UPDATE: Accuracy tracking prediction system**
- ✅ **Replaced credit-based betting with prediction accuracy tracking**
- ✅ **Per-player, per-channel isolated prediction statistics**
- ✅ **Interactive prediction panels with 4-minute countdown timers**
- ✅ **Champion portraits and visual enhancements**
- ✅ **Leaderboards and streak tracking**
- ✅ **Duplicate panel prevention across deployments**

## Prediction System Features
- **Real-time predictions**: 4-minute windows with Discord dynamic timers
- **Team analysis**: Shows champion winrates, tracked player stats
- **Flexible predictions**: Users can change predictions until deadline expires
- **Accuracy tracking**: Personal statistics isolated per tracked player and channel
- **Leaderboards**: Channel-specific rankings based on prediction accuracy
- **Streak tracking**: Current and best prediction streaks for each user
- **Visual design**: Champion portraits, team layouts, clear messaging
- **Production ready**: Deploy-resistant, no duplicate panels, proper error handling

## Pending Todo Items

### 1. Enhanced Prediction Features
- Add game duration check to prevent predictions on games >5 minutes old
- Add admin functionality to edit user accuracy stats (for bugs/exploits)
- Add prediction results display within prediction panels

### 2. Additional Daily Features
- Add manual daily summary command (/daily)
- Track weekly trends and statistics
- Display historical daily performance comparison

### 3. Detailed Player Information  
- Show LP, current rank, recent winrate
- Display best/most played champions
- Performance metrics and trends

### 4. Advanced Features
- Implement multiple player tracking capability
- Track different players in different channels
- Add predictions on multiple games simultaneously

## Technical Notes
- **Database**: PostgreSQL on Railway with persistent storage
- **APIs**: Riot Account API, Summoner API, Spectator API v5, Data Dragon for champion images
- **Game Tracking**: Only ranked solo/duo games (queue ID 420)
- **Daily Logic**: Automatic daily summary at midnight, resets tracking for new day
- **Prediction System**: 4-minute prediction windows, deployment-resistant panel tracking
- **Bot Permissions**: Manage Roles (for Paparazzi role creation/assignment)
- **Data Persistence**: All prediction panels, user accuracy stats, daily tracking data persisted in PostgreSQL

## Database Admin Instructions

### Editing User Prediction Stats (Railway Dashboard)
1. Go to Railway project → PostgreSQL service → Data tab
2. **View all users**: `SELECT user_id, tracked_player_name, total_predictions, correct_predictions, accuracy_percentage, current_streak, best_streak FROM user_prediction_accuracy ORDER BY accuracy_percentage DESC;`
3. **Edit user accuracy**: `UPDATE user_prediction_accuracy SET correct_predictions = 15, total_predictions = 20, accuracy_percentage = 75.0 WHERE user_id = 'DISCORD_USER_ID_HERE' AND tracked_player_puuid = 'PLAYER_PUUID_HERE';`
4. **Reset user stats**: `UPDATE user_prediction_accuracy SET total_predictions = 0, correct_predictions = 0, accuracy_percentage = 0, current_streak = 0 WHERE user_id = 'DISCORD_USER_ID_HERE';`
5. **Find user IDs**: Enable Discord Developer Mode → Right-click user → Copy User ID

### Database Tables
- `user_prediction_accuracy`: User accuracy stats per tracked player/channel
- `active_predictions`: Current predictions on ongoing games  
- `betting_panels`: Tracks sent panels to prevent duplicates
- `prediction_history`: Historical prediction records with outcomes
- `player_tracking`: Session and game tracking data
- `session_games`: Individual game results and stats

## Development Guidelines
- Continuously check if variables or data is persisted correctly with each new feature
- Keep README.md documentation current and comprehensive for developers
- Update README.md whenever new features, commands, or configuration options are added
- Test prediction functionality thoroughly with deployment scenarios
- Monitor database for proper cleanup of old prediction panels
- Ensure accuracy tracking stats are isolated per player and per channel
- Legacy betting tables maintained for migration period but are deprecated