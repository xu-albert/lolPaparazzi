const fs = require('fs').promises;
const path = require('path');

class PersistenceManager {
    constructor() {
        // Use Railway environment variables for persistence since filesystem is ephemeral
        this.envPrefix = 'BOT_TRACKING_';
    }

    async saveTrackingData(playerSession) {
        try {
            // Note: Can't actually set env vars at runtime in Railway
            // This is a limitation - Railway filesystem is ephemeral
            // For now, just log that we would save it
            console.log('📁 Would save tracking data (Railway filesystem is ephemeral)');
            console.log(`   Channel: ${playerSession.channelId}`);
            console.log(`   Summoner: ${playerSession.summonerName}`);
        } catch (error) {
            console.error('Error saving tracking data:', error.message);
        }
    }

    async loadTrackingData() {
        try {
            // Try to read from environment variables that might be manually set
            const channelId = process.env.PERSISTENT_CHANNEL_ID;
            const summonerName = process.env.PERSISTENT_SUMMONER_NAME;
            const originalInput = process.env.PERSISTENT_ORIGINAL_INPUT;
            
            if (channelId && summonerName) {
                console.log('📥 Found persistent tracking data in environment variables');
                return {
                    channelId,
                    summonerName,
                    originalInput: originalInput || summonerName,
                    lastSaved: 'environment-variables'
                };
            }
            
            return null;
        } catch (error) {
            console.error('Error loading tracking data:', error.message);
            return null;
        }
    }

    async clearTrackingData() {
        console.log('🗑️ Tracking data cleared (would remove env vars if possible)');
    }
}

module.exports = PersistenceManager;