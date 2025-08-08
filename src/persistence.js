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
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ Database table initialized');
            
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
            // Clear existing data and insert new (simple upsert for single-user bot)
            await this.pool.query('DELETE FROM player_tracking');
            
            const query = `
                INSERT INTO player_tracking (
                    channel_id, summoner_name, original_input, in_session,
                    session_start_time, game_count, current_game_id, 
                    last_game_check, last_completed_game_id, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
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
                playerSession.lastCompletedGameId
            ]);
            
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