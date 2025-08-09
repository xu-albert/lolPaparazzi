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
                    ADD COLUMN IF NOT EXISTS current_lp INTEGER
                `);
                console.log('✅ Database columns migrated');
            } catch (migrationError) {
                console.log('ℹ️ Column migration skipped (likely already exist):', migrationError.message);
            }
            
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
            
            // Check if any existing data
            const countResult = await this.pool.query('SELECT COUNT(*) FROM player_tracking');
            console.log(`📊 Existing tracking records: ${countResult.rows[0].count}`);
            
        } catch (error) {
            console.error('❌ Error initializing database:', error.message);
            console.error('❌ Full error:', error);
        }
    }

    async saveTrackingData(playerSession) {
        if (!this.databaseAvailable) {
            console.log('⚠️  Cannot save tracking data - database not configured');
            return;
        }
        
        try {
            // Simple approach: Clear and insert (safer for single-user bot)
            // But make it atomic to prevent data loss
            await this.pool.query('BEGIN');
            
            try {
                await this.pool.query('DELETE FROM player_tracking');
                
                const query = `
                    INSERT INTO player_tracking (
                        channel_id, summoner_name, original_input, in_session,
                        session_start_time, game_count, current_game_id, 
                        last_game_check, last_completed_game_id,
                        first_game_start_time, last_game_end_time, 
                        session_start_lp, current_lp, updated_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP)
                `;
                
                await this.pool.query(query, [
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
                    playerSession.currentLP
                ]);
                
                await this.pool.query('COMMIT');
            } catch (insertError) {
                await this.pool.query('ROLLBACK');
                throw insertError;
            }
            
            console.log('💾 Full session state saved to database');
        } catch (error) {
            console.error('❌ Error saving tracking data:', error.message);
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

    async clearTrackingData() {
        if (!this.databaseAvailable) {
            console.log('ℹ️ Database not available - nothing to clear');
            return;
        }
        
        try {
            await this.pool.query('DELETE FROM player_tracking');
            console.log('🗑️ Tracking data cleared from database');
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

    async close() {
        try {
            await this.pool.end();
            console.log('🔌 Database connection closed');
        } catch (error) {
            console.error('❌ Error closing database:', error.message);
        }
    }
}

module.exports = PersistenceManager;