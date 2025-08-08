# LoL Paparazzi Development Notes

## Current Status
- ✅ Core bot functionality complete with PostgreSQL persistence
- ✅ Session-based tracking (start/end notifications)
- ✅ Riot ID support with Account API integration  
- ✅ Smart polling: 3min idle, 5min during sessions
- ✅ Deployed on Railway with auto-redeploys

## Pending Todo Items

### 1. Fix Missing Summoner ID Issue  
- Investigate why Riot Summoner API response is missing `id` field
- This prevents rank display in setup messages and commands
- All other functionality works (uses PUUID), but rank info needs the encrypted summoner ID

### 2. Role Ping System
- Add role ping functionality when gaming session starts
- Create role self-assignment system for users to opt-in to notifications

### 3. Enhanced Tracking
- Implement multiple player tracking capability
- Track different players in different channels

### 4. Session Analytics
- Add win/loss summary after each session ends
- Track LP gain/loss for each session
- Display session statistics (games played, duration, performance)

### 5. Detailed Player Information  
- Show LP, current rank, recent winrate
- Display best/most played champions
- Performance metrics and trends

## Technical Notes
- Database: PostgreSQL on Railway with persistent storage
- APIs: Riot Account API, Summoner API, Spectator API v5
- Only tracks ranked solo/duo games (queue ID 420)
- Session timeout: 15 minutes of inactivity