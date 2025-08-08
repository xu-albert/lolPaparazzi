const fs = require('fs').promises;
const path = require('path');

class PersistenceManager {
    constructor() {
        this.dataFile = path.join(process.cwd(), 'data', 'tracking.json');
        this.ensureDataDirectory();
    }

    async ensureDataDirectory() {
        try {
            await fs.mkdir(path.dirname(this.dataFile), { recursive: true });
        } catch (error) {
            console.error('Error creating data directory:', error.message);
        }
    }

    async saveTrackingData(playerSession) {
        try {
            // Only save essential data, not runtime state
            const dataToSave = {
                channelId: playerSession.channelId,
                summonerName: playerSession.summonerName,
                originalInput: playerSession.originalInput,
                lastSaved: new Date().toISOString()
            };

            await fs.writeFile(this.dataFile, JSON.stringify(dataToSave, null, 2));
            console.log('Tracking data saved successfully');
        } catch (error) {
            console.error('Error saving tracking data:', error.message);
        }
    }

    async loadTrackingData() {
        try {
            const data = await fs.readFile(this.dataFile, 'utf8');
            const parsedData = JSON.parse(data);
            console.log(`Restored tracking data from ${parsedData.lastSaved}`);
            return parsedData;
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log('No existing tracking data found');
            } else {
                console.error('Error loading tracking data:', error.message);
            }
            return null;
        }
    }

    async clearTrackingData() {
        try {
            await fs.unlink(this.dataFile);
            console.log('Tracking data cleared');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('Error clearing tracking data:', error.message);
            }
        }
    }
}

module.exports = PersistenceManager;