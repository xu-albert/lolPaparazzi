# LoL Paparazzi Development Notes

## Current Status
- ✅ Core bot functionality complete with PostgreSQL persistence
- ✅ Session-based tracking (start/end notifications)
- ✅ Riot ID support with Account API integration  
- ✅ Smart polling: 3min idle, 5min during sessions
- ✅ Deployed on Railway with auto-redeploys
- ✅ Fixed summoner ID issue - now uses PUUID for rank lookups
- ✅ Role ping system with /join and /leave commands

## Pending Todo Items

### 1. Session Analytics
- Add win/loss summary after each session ends
- Track LP gain/loss for each session
- Display session statistics (games played, duration, performance)

### 2. Detailed Player Information  
- Show LP, current rank, recent winrate
- Display best/most played champions
- Performance metrics and trends

### 3. Enhanced Tracking
- Implement multiple player tracking capability
- Track different players in different channels

## Technical Notes
- Database: PostgreSQL on Railway with persistent storage
- APIs: Riot Account API, Summoner API, Spectator API v5
- Only tracks ranked solo/duo games (queue ID 420)
- Session timeout: 15 minutes of inactivity
- Bot permissions required: Manage Roles (for Paparazzi role creation/assignment)