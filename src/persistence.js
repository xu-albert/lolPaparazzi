const { Pool } = require('pg');

class PersistenceManager {
    constructor() {
        this.databaseAvailable = !!process.env.DATABASE_URL;
        
        if (this.databaseAvailable) {
            // Connect to Railway PostgreSQL database
            this.pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
            });
            this.initializeDatabase();
        } else {
            console.log('⚠️  DATABASE_URL not found - persistence disabled until PostgreSQL is configured');
        }
    }

    async initializeDatabase() {
        try {
            console.log('🔌 Connecting to PostgreSQL database...');
            console.log('DATABASE_URL exists:', !!process.env.DATABASE_URL);
            
            // Test connection first
            const testResult = await this.pool.query('SELECT NOW()');
            console.log('✅ Database connection successful:', testResult.rows[0].now);
            
            // Create tracking table if it doesn't exist
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS player_tracking (
                    id SERIAL PRIMARY KEY,
                    channel_id VARCHAR(255) NOT NULL,
                    summoner_name VARCHAR(255) NOT NULL,
                    original_input VARCHAR(255) NOT NULL,
                    in_session BOOLEAN DEFAULT FALSE,
                    session_start_time TIMESTAMP WITH TIME ZONE,
                    game_count INTEGER DEFAULT 0,
                    current_game_id VARCHAR(255),
                    last_game_check TIMESTAMP WITH TIME ZONE,
                    last_completed_game_id VARCHAR(255),
                    first_game_start_time TIMESTAMP WITH TIME ZONE,
                    last_game_end_time TIMESTAMP WITH TIME ZONE,
                    session_start_lp INTEGER,
                    current_lp INTEGER,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ Database table initialized');
            
            // Add new columns if they don't exist (migration for existing databases)
            try {
                await this.pool.query(`
                    ALTER TABLE player_tracking 
                    ADD COLUMN IF NOT EXISTS first_game_start_time TIMESTAMP WITH TIME ZONE,
                    ADD COLUMN IF NOT EXISTS last_game_end_time TIMESTAMP WITH TIME ZONE,
                    ADD COLUMN IF NOT EXISTS session_start_lp INTEGER,
                    ADD COLUMN IF NOT EXISTS current_lp INTEGER,
                    ADD COLUMN IF NOT EXISTS non_ranked_games INTEGER DEFAULT 0
                `);
                console.log('✅ Database columns migrated');
            } catch (migrationError) {
                console.log('ℹ️ Column migration skipped (likely already exist):', migrationError.message);
            }
            
            // Create session games table for individual game records
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS session_games (
                    id SERIAL PRIMARY KEY,
                    player_session_id INTEGER,
                    match_id VARCHAR(255) NOT NULL,
                    champion VARCHAR(255) NOT NULL,
                    champion_id INTEGER,
                    win BOOLEAN NOT NULL,
                    kills INTEGER NOT NULL,
                    deaths INTEGER NOT NULL,
                    assists INTEGER NOT NULL,
                    kda_ratio DECIMAL(5,2),
                    cs INTEGER NOT NULL,
                    cs_per_min DECIMAL(4,1),
                    game_duration_seconds INTEGER NOT NULL,
                    game_duration_text VARCHAR(20),
                    lp_change INTEGER,
                    game_start_time TIMESTAMP WITH TIME ZONE NOT NULL,
                    game_end_time TIMESTAMP WITH TIME ZONE NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (player_session_id) REFERENCES player_tracking(id) ON DELETE CASCADE
                )
            `);
            console.log('✅ Session games table initialized');

            // Add new columns to session_games table if they don't exist
            try {
                await this.pool.query(`
                    ALTER TABLE session_games 
                    ADD COLUMN IF NOT EXISTS queue_id INTEGER,
                    ADD COLUMN IF NOT EXISTS is_ranked BOOLEAN DEFAULT true
                `);
                console.log('✅ Session games table columns migrated');
            } catch (migrationError) {
                console.log('ℹ️ Session games column migration skipped (likely already exist):', migrationError.message);
            }

            // Create session stats table for aggregated statistics
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS session_stats (
                    id SERIAL PRIMARY KEY,
                    player_session_id INTEGER UNIQUE,
                    wins INTEGER DEFAULT 0,
                    losses INTEGER DEFAULT 0,
                    total_lp_gained INTEGER DEFAULT 0,
                    best_game_kda DECIMAL(5,2),
                    best_game_champion VARCHAR(255),
                    best_game_match_id VARCHAR(255),
                    worst_game_kda DECIMAL(5,2),
                    worst_game_champion VARCHAR(255),
                    worst_game_match_id VARCHAR(255),
                    champion_stats JSONB, -- {championName: {games, wins, losses}}
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (player_session_id) REFERENCES player_tracking(id) ON DELETE CASCADE
                )
            `);
            console.log('✅ Session stats table initialized');

            // Create pending match analysis queue table
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS pending_match_analysis (
                    id SERIAL PRIMARY KEY,
                    summoner_puuid VARCHAR(255) NOT NULL,
                    game_id VARCHAR(255),
                    summoner_data JSONB NOT NULL,
                    scheduled_time TIMESTAMP WITH TIME ZONE NOT NULL,
                    retry_count INTEGER DEFAULT 0,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ Match analysis queue table initialized');
            
            // Create betting system tables
            await this.initializeBettingTables();
            
            // Check if any existing data
            const countResult = await this.pool.query('SELECT COUNT(*) FROM player_tracking');
            console.log(`📊 Existing tracking records: ${countResult.rows[0].count}`);
            
        } catch (error) {
            console.error('❌ Error initializing database:', error.message);
            console.error('❌ Full error:', error);
        }
    }

    async initializeBettingTables() {
        try {
            console.log('🎰 Initializing betting system tables...');
            
            // Create user credits table
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS user_credits (
                    id SERIAL PRIMARY KEY,
                    user_id VARCHAR(255) NOT NULL UNIQUE,
                    guild_id VARCHAR(255) NOT NULL,
                    balance INTEGER DEFAULT 100,
                    last_daily_claim DATE,
                    total_winnings INTEGER DEFAULT 0,
                    total_losses INTEGER DEFAULT 0,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ User credits table initialized');
            
            // Create active bets table
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS active_bets (
                    id SERIAL PRIMARY KEY,
                    user_id VARCHAR(255) NOT NULL,
                    guild_id VARCHAR(255) NOT NULL,
                    game_id VARCHAR(255) NOT NULL,
                    player_puuid VARCHAR(255) NOT NULL,
                    bet_amount INTEGER NOT NULL,
                    bet_outcome VARCHAR(10) NOT NULL,
                    channel_id VARCHAR(255) NOT NULL,
                    game_start_time TIMESTAMP WITH TIME ZONE NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    resolved_at TIMESTAMP WITH TIME ZONE,
                    status VARCHAR(20) DEFAULT 'active'
                )
            `);
            console.log('✅ Active bets table initialized');
            
            // Create betting panels table to prevent duplicates
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS betting_panels (
                    id SERIAL PRIMARY KEY,
                    game_id VARCHAR(255) NOT NULL UNIQUE,
                    message_id VARCHAR(255) NOT NULL,
                    channel_id VARCHAR(255) NOT NULL,
                    player_puuid VARCHAR(255) NOT NULL,
                    sent_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    game_start_time TIMESTAMP WITH TIME ZONE
                )
            `);
            console.log('✅ Betting panels table initialized');
            
            // Create bet history table
            await this.pool.query(`
                CREATE TABLE IF NOT EXISTS bet_history (
                    id SERIAL PRIMARY KEY,
                    user_id VARCHAR(255) NOT NULL,
                    guild_id VARCHAR(255) NOT NULL,
                    bet_amount INTEGER NOT NULL,
                    bet_outcome VARCHAR(10) NOT NULL,
                    actual_outcome VARCHAR(10) NOT NULL,
                    result VARCHAR(20) NOT NULL,
                    payout_amount INTEGER DEFAULT 0,
                    match_id VARCHAR(255),
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ Bet history table initialized');
            
        } catch (error) {
            console.error('❌ Error initializing betting tables:', error.message);
        }
    }

    async saveTrackingData(playerSession) {
        if (!this.databaseAvailable) {
            console.log('⚠️  Cannot save tracking data - database not configured');
            return;
        }
        
        try {
            await this.pool.query('BEGIN');
            
            if (playerSession.id) {
                // Update existing player session
                const query = `
                    UPDATE player_tracking SET
                        in_session = $2, session_start_time = $3, game_count = $4, 
                        current_game_id = $5, last_game_check = $6, last_completed_game_id = $7,
                        first_game_start_time = $8, last_game_end_time = $9,
                        session_start_lp = $10, current_lp = $11, non_ranked_games = $12, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                    RETURNING id
                `;
                
                const result = await this.pool.query(query, [
                    playerSession.id,
                    playerSession.inSession,
                    playerSession.sessionStartTime,
                    playerSession.gameCount,
                    playerSession.currentGameId,
                    playerSession.lastGameCheck,
                    playerSession.lastCompletedGameId,
                    playerSession.firstGameStartTime,
                    playerSession.lastGameEndTime,
                    playerSession.sessionStartLP,
                    playerSession.currentLP,
                    playerSession.nonRankedGames || 0
                ]);
                
                if (result.rows.length === 0) {
                    throw new Error('Player session not found for update');
                }
                
                await this.pool.query('COMMIT');
                console.log(`💾 Updated tracking data for session ID: ${playerSession.id}`);
                return playerSession.id;
            } else {
                // Check if any player is already being tracked in this channel
                const existingQuery = `
                    SELECT id, summoner_name FROM player_tracking 
                    WHERE channel_id = $1
                `;
                const existingResult = await this.pool.query(existingQuery, [
                    playerSession.channelId
                ]);
                
                if (existingResult.rows.length > 0) {
                    const existingPlayer = existingResult.rows[0];
                    const existingId = existingPlayer.id;
                    const existingSummonerName = existingPlayer.summoner_name;
                    
                    if (existingSummonerName === playerSession.summonerName) {
                        // Same player - update existing record
                        playerSession.id = existingId;
                        
                        const updateQuery = `
                            UPDATE player_tracking SET
                                original_input = $2, in_session = $3, session_start_time = $4, 
                                game_count = $5, current_game_id = $6, last_game_check = $7, 
                                last_completed_game_id = $8, first_game_start_time = $9, 
                                last_game_end_time = $10, session_start_lp = $11, current_lp = $12,
                                non_ranked_games = $13, updated_at = CURRENT_TIMESTAMP
                            WHERE id = $1
                            RETURNING id
                        `;
                        
                        const result = await this.pool.query(updateQuery, [
                            existingId,
                            playerSession.originalInput,
                            playerSession.inSession,
                            playerSession.sessionStartTime,
                            playerSession.gameCount,
                            playerSession.currentGameId,
                            playerSession.lastGameCheck,
                            playerSession.lastCompletedGameId,
                            playerSession.firstGameStartTime,
                            playerSession.lastGameEndTime,
                            playerSession.sessionStartLP,
                            playerSession.currentLP,
                            playerSession.nonRankedGames || 0
                        ]);
                        
                        await this.pool.query('COMMIT');
                        console.log(`💾 Updated existing player tracking data (ID: ${existingId})`);
                        return existingId;
                    } else {
                        // Different player already being tracked in this channel
                        await this.pool.query('ROLLBACK');
                        throw new Error(`CHANNEL_OCCUPIED:${existingSummonerName}`);
                    }
                } else {
                    // Insert new player session
                    const insertQuery = `
                        INSERT INTO player_tracking (
                            channel_id, summoner_name, original_input, in_session,
                            session_start_time, game_count, current_game_id, 
                            last_game_check, last_completed_game_id,
                            first_game_start_time, last_game_end_time, 
                            session_start_lp, current_lp, non_ranked_games, updated_at
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)
                        RETURNING id
                    `;
                    
                    const result = await this.pool.query(insertQuery, [
                        playerSession.channelId,
                        playerSession.summonerName,
                        playerSession.originalInput,
                        playerSession.inSession,
                        playerSession.sessionStartTime,
                        playerSession.gameCount,
                        playerSession.currentGameId,
                        playerSession.lastGameCheck,
                        playerSession.lastCompletedGameId,
                        playerSession.firstGameStartTime,
                        playerSession.lastGameEndTime,
                        playerSession.sessionStartLP,
                        playerSession.currentLP,
                        playerSession.nonRankedGames || 0
                    ]);
                    
                    await this.pool.query('COMMIT');
                    
                    const sessionId = result.rows[0].id;
                    console.log(`💾 New player tracking data saved (ID: ${sessionId})`);
                    return sessionId;
                }
            }
        } catch (error) {
            await this.pool.query('ROLLBACK');
            console.error('❌ Error saving tracking data:', error.message);
            return null;
        }
    }

    async loadTrackingData() {
        if (!this.databaseAvailable) {
            console.log('ℹ️ Database not available - no tracking data to restore');
            return null;
        }
        
        try {
            const result = await this.pool.query(
                'SELECT * FROM player_tracking ORDER BY updated_at DESC LIMIT 1'
            );
            
            if (result.rows.length > 0) {
                const row = result.rows[0];
                console.log(`📥 Restored full session state from database (updated: ${row.updated_at})`);
                console.log(`🎮 Session active: ${row.in_session}, Games: ${row.game_count}`);
                
                return {
                    id: row.id, // Add session ID for foreign key relationships
                    channelId: row.channel_id,
                    summonerName: row.summoner_name,
                    originalInput: row.original_input,
                    inSession: row.in_session,
                    sessionStartTime: row.session_start_time ? new Date(row.session_start_time) : null,
                    gameCount: row.game_count || 0,
                    currentGameId: row.current_game_id,
                    lastGameCheck: row.last_game_check ? new Date(row.last_game_check) : null,
                    lastCompletedGameId: row.last_completed_game_id,
                    firstGameStartTime: row.first_game_start_time ? new Date(row.first_game_start_time) : null,
                    lastGameEndTime: row.last_game_end_time ? new Date(row.last_game_end_time) : null,
                    sessionStartLP: row.session_start_lp,
                    currentLP: row.current_lp,
                    nonRankedGames: row.non_ranked_games || 0,
                    lastSaved: row.updated_at
                };
            }
            
            console.log('ℹ️ No tracking data found in database');
            return null;
        } catch (error) {
            console.error('❌ Error loading tracking data:', error.message);
            return null;
        }
    }

    async clearTrackingData(channelId = null) {
        if (!this.databaseAvailable) {
            console.log('ℹ️ Database not available - nothing to clear');
            return;
        }
        
        try {
            if (channelId) {
                // Clear tracking data for specific channel only
                await this.pool.query('DELETE FROM player_tracking WHERE channel_id = $1', [channelId]);
                console.log(`🗑️ Tracking data cleared for channel ${channelId}`);
            } else {
                // Clear all tracking data (backward compatibility)
                await this.pool.query('DELETE FROM player_tracking');
                console.log('🗑️ All tracking data cleared from database');
            }
        } catch (error) {
            console.error('❌ Error clearing tracking data:', error.message);
        }
    }

    async queueMatchAnalysis(summonerData, gameId = null, delayMinutes = 0.5) {
        if (!this.databaseAvailable) {
            console.log('⚠️ Cannot queue match analysis - database not configured');
            return;
        }
        
        try {
            const scheduledTime = new Date(Date.now() + delayMinutes * 60 * 1000);
            
            const query = `
                INSERT INTO pending_match_analysis (
                    summoner_puuid, game_id, summoner_data, scheduled_time
                )
                VALUES ($1, $2, $3, $4)
                RETURNING id
            `;
            
            const result = await this.pool.query(query, [
                summonerData.puuid,
                gameId,
                JSON.stringify(summonerData),
                scheduledTime
            ]);
            
            console.log(`📝 Queued match analysis (ID: ${result.rows[0].id}) for ${summonerData.gameName}#${summonerData.tagLine}`);
            return result.rows[0].id;
        } catch (error) {
            console.error('❌ Error queuing match analysis:', error.message);
        }
    }

    async getPendingMatchAnalysis() {
        if (!this.databaseAvailable) {
            return [];
        }
        
        try {
            const now = new Date();
            const result = await this.pool.query(`
                SELECT * FROM pending_match_analysis 
                WHERE scheduled_time <= $1 AND retry_count < 3
                ORDER BY scheduled_time ASC
                LIMIT 5
            `, [now]);
            
            return result.rows.map(row => ({
                id: row.id,
                summonerPuuid: row.summoner_puuid,
                gameId: row.game_id,
                summonerData: row.summoner_data,
                scheduledTime: new Date(row.scheduled_time),
                retryCount: row.retry_count,
                createdAt: new Date(row.created_at)
            }));
        } catch (error) {
            console.error('❌ Error fetching pending match analysis:', error.message);
            return [];
        }
    }

    async markAnalysisComplete(analysisId) {
        if (!this.databaseAvailable) {
            return;
        }
        
        try {
            await this.pool.query('DELETE FROM pending_match_analysis WHERE id = $1', [analysisId]);
            console.log(`✅ Completed match analysis (ID: ${analysisId})`);
        } catch (error) {
            console.error('❌ Error marking analysis complete:', error.message);
        }
    }

    async markAnalysisRetry(analysisId) {
        if (!this.databaseAvailable) {
            return;
        }
        
        try {
            // Increment retry count and reschedule for 2 minutes later
            const newScheduledTime = new Date(Date.now() + 2 * 60 * 1000);
            
            await this.pool.query(`
                UPDATE pending_match_analysis 
                SET retry_count = retry_count + 1, scheduled_time = $2
                WHERE id = $1
            `, [analysisId, newScheduledTime]);
            
            console.log(`🔄 Rescheduled match analysis (ID: ${analysisId}) for retry`);
        } catch (error) {
            console.error('❌ Error rescheduling analysis:', error.message);
        }
    }

    async cleanupOldAnalysis() {
        if (!this.databaseAvailable) {
            return;
        }
        
        try {
            // Remove analysis entries older than 24 hours or with too many retries
            const result = await this.pool.query(`
                DELETE FROM pending_match_analysis 
                WHERE created_at < NOW() - INTERVAL '24 hours' OR retry_count >= 3
            `);
            
            if (result.rowCount > 0) {
                console.log(`🧹 Cleaned up ${result.rowCount} old match analysis entries`);
            }
        } catch (error) {
            console.error('❌ Error cleaning up old analysis:', error.message);
        }
    }

    // Save individual game record to database
    async saveGameRecord(playerSessionId, gameData, matchData) {
        if (!this.databaseAvailable) {
            console.log('⚠️ Cannot save game record - database not configured');
            return;
        }
        
        try {
            const gameDurationSeconds = Math.floor(matchData.info.gameDuration);
            const gameStartTime = new Date(matchData.info.gameStartTimestamp);
            const gameEndTime = new Date(matchData.info.gameEndTimestamp);
            
            const query = `
                INSERT INTO session_games (
                    player_session_id, match_id, champion, champion_id, win,
                    kills, deaths, assists, kda_ratio, cs, cs_per_min,
                    game_duration_seconds, game_duration_text, lp_change,
                    game_start_time, game_end_time
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                RETURNING id
            `;
            
            const kdaValue = gameData.kda === 'Perfect' ? 99.0 : parseFloat(gameData.kda);
            
            const result = await this.pool.query(query, [
                playerSessionId,
                gameData.matchId,
                gameData.championName,
                null, // We'll need to pass championId separately if needed
                gameData.win,
                gameData.kills,
                gameData.deaths,
                gameData.assists,
                kdaValue,
                gameData.cs,
                parseFloat(gameData.csPerMin),
                gameDurationSeconds,
                gameData.gameDuration,
                gameData.lpChange || null,
                gameStartTime,
                gameEndTime
            ]);
            
            console.log(`💾 Saved game record (ID: ${result.rows[0].id}): ${gameData.championName} ${gameData.win ? 'W' : 'L'}`);
            return result.rows[0].id;
            
        } catch (error) {
            console.error('❌ Error saving game record:', error.message);
        }
    }

    // Save session statistics to database
    async saveSessionStats(playerSessionId, sessionStats) {
        if (!this.databaseAvailable) {
            console.log('⚠️ Cannot save session stats - database not configured');
            return;
        }
        
        try {
            const query = `
                INSERT INTO session_stats (
                    player_session_id, wins, losses, total_lp_gained,
                    best_game_kda, best_game_champion, best_game_match_id,
                    worst_game_kda, worst_game_champion, worst_game_match_id,
                    champion_stats
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                ON CONFLICT (player_session_id)
                DO UPDATE SET
                    wins = EXCLUDED.wins,
                    losses = EXCLUDED.losses,
                    total_lp_gained = EXCLUDED.total_lp_gained,
                    best_game_kda = EXCLUDED.best_game_kda,
                    best_game_champion = EXCLUDED.best_game_champion,
                    best_game_match_id = EXCLUDED.best_game_match_id,
                    worst_game_kda = EXCLUDED.worst_game_kda,
                    worst_game_champion = EXCLUDED.worst_game_champion,
                    worst_game_match_id = EXCLUDED.worst_game_match_id,
                    champion_stats = EXCLUDED.champion_stats,
                    updated_at = CURRENT_TIMESTAMP
            `;
            
            await this.pool.query(query, [
                playerSessionId,
                sessionStats.wins,
                sessionStats.losses,
                sessionStats.lpGained,
                sessionStats.bestGame ? sessionStats.bestGame.kdaValue : null,
                sessionStats.bestGame ? sessionStats.bestGame.champion : null,
                sessionStats.bestGame ? sessionStats.bestGame.matchId : null,
                sessionStats.worstGame ? sessionStats.worstGame.kdaValue : null,
                sessionStats.worstGame ? sessionStats.worstGame.champion : null,
                sessionStats.worstGame ? sessionStats.worstGame.matchId : null,
                JSON.stringify(sessionStats.champions)
            ]);
            
            console.log(`📊 Saved session stats: ${sessionStats.wins}W-${sessionStats.losses}L`);
            
        } catch (error) {
            console.error('❌ Error saving session stats:', error.message);
        }
    }

    // Load session games from database
    async loadSessionGames(playerSessionId, sessionStartTime = null) {
        if (!this.databaseAvailable) {
            return [];
        }
        
        try {
            let query = `
                SELECT * FROM session_games 
                WHERE player_session_id = $1
            `;
            let params = [playerSessionId];
            
            // Filter by session start time if provided (prevents loading games from previous sessions)
            if (sessionStartTime) {
                query += ` AND game_start_time >= $2`;
                params.push(sessionStartTime);
            }
            
            query += ` ORDER BY game_start_time ASC`;
            
            const result = await this.pool.query(query, params);
            
            const games = result.rows.map(row => ({
                champion: row.champion,
                win: row.win,
                kda: row.kda_ratio === 99 ? 'Perfect' : row.kda_ratio.toString(),
                cs: row.cs,
                csPerMin: row.cs_per_min.toString(),
                duration: row.game_duration_text,
                lpChange: row.lp_change,
                matchId: row.match_id,
                gameStartTime: row.game_start_time,
                gameEndTime: row.game_end_time
            }));
            
            if (sessionStartTime) {
                console.log(`📥 Loaded ${games.length} session games from database (filtered by session start: ${sessionStartTime.toISOString()})`);
            } else {
                console.log(`📥 Loaded ${games.length} session games from database (no filtering)`);
            }
            return games;
            
        } catch (error) {
            console.error('❌ Error loading session games:', error.message);
            return [];
        }
    }

    // Load session stats from database
    async loadSessionStats(playerSessionId) {
        if (!this.databaseAvailable) {
            return null;
        }
        
        try {
            const result = await this.pool.query(`
                SELECT * FROM session_stats WHERE player_session_id = $1
            `, [playerSessionId]);
            
            if (result.rows.length === 0) {
                return null;
            }
            
            const row = result.rows[0];
            const stats = {
                wins: row.wins,
                losses: row.losses,
                lpGained: row.total_lp_gained,
                champions: row.champion_stats || {},
                bestGame: null,
                worstGame: null
            };
            
            if (row.best_game_kda) {
                stats.bestGame = {
                    kdaValue: parseFloat(row.best_game_kda),
                    kda: row.best_game_kda === 99 ? 'Perfect' : row.best_game_kda.toString(),
                    champion: row.best_game_champion,
                    matchId: row.best_game_match_id
                };
            }
            
            if (row.worst_game_kda) {
                stats.worstGame = {
                    kdaValue: parseFloat(row.worst_game_kda),
                    kda: row.worst_game_kda === 99 ? 'Perfect' : row.worst_game_kda.toString(),
                    champion: row.worst_game_champion,
                    matchId: row.worst_game_match_id
                };
            }
            
            console.log(`📊 Loaded session stats: ${stats.wins}W-${stats.losses}L`);
            return stats;
            
        } catch (error) {
            console.error('❌ Error loading session stats:', error.message);
            return null;
        }
    }

    async close() {
        try {
            await this.pool.end();
            console.log('🔌 Database connection closed');
        } catch (error) {
            console.error('❌ Error closing database:', error.message);
        }
    }

    // Betting panel management methods
    async saveBettingPanel(gameId, messageId, channelId, playerPuuid, gameStartTime) {
        try {
            if (!this.databaseAvailable) return null;

            const result = await this.pool.query(`
                INSERT INTO betting_panels (game_id, message_id, channel_id, player_puuid, game_start_time)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (game_id) DO NOTHING
                RETURNING id
            `, [gameId, messageId, channelId, playerPuuid, gameStartTime]);

            return result.rows.length > 0 ? result.rows[0].id : null;
        } catch (error) {
            console.error('Error saving betting panel:', error);
            return null;
        }
    }

    async checkBettingPanelExists(gameId) {
        try {
            if (!this.databaseAvailable) return false;

            const result = await this.pool.query(`
                SELECT id FROM betting_panels WHERE game_id = $1
            `, [gameId]);

            return result.rows.length > 0;
        } catch (error) {
            console.error('Error checking betting panel:', error);
            return false;
        }
    }

    async cleanupOldBettingPanels() {
        try {
            if (!this.databaseAvailable) return;

            // Clean up betting panels older than 2 hours
            const result = await this.pool.query(`
                DELETE FROM betting_panels 
                WHERE sent_at < NOW() - INTERVAL '2 hours'
            `);

            if (result.rowCount > 0) {
                console.log(`🧹 Cleaned up ${result.rowCount} old betting panels`);
            }
        } catch (error) {
            console.error('Error cleaning up betting panels:', error);
        }
    }
}

module.exports = PersistenceManager;