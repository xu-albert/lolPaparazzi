const cron = require('node-cron');

class PlayerTracker {
    constructor(riotApi, discordClient) {
        this.riotApi = riotApi;
        this.discordClient = discordClient;
        this.playerSession = {
            summonerName: null,
            channelId: null,
            inSession: false,
            lastGameCheck: null,
            sessionStartTime: null,
            gameCount: 0
        };
        this.cronJob = null;
        // Session ends after 15 minutes of no ranked games
        this.sessionTimeoutMinutes = 15;
    }

    setPlayer(channelId, summonerName) {
        this.playerSession.channelId = channelId;
        this.playerSession.summonerName = summonerName;
        console.log(`Now tracking ${summonerName} in channel ${channelId}`);
    }

    isSessionActive() {
        return this.playerSession.inSession;
    }

    shouldEndSession() {
        if (!this.playerSession.inSession) return false;
        
        const now = new Date();
        const timeSinceLastGame = (now - this.playerSession.lastGameCheck) / 1000 / 60; // minutes
        
        return timeSinceLastGame > this.sessionTimeoutMinutes;
    }

    async checkPlayer() {
        if (!this.playerSession.summonerName) return;
        
        try {
            const summoner = await this.riotApi.getSummonerByName(this.playerSession.summonerName);
            const currentGame = await this.riotApi.getCurrentGame(summoner.id);
            const now = new Date();
            
            if (currentGame && this.riotApi.isRankedSoloGame(currentGame)) {
                // Player is in a ranked game
                this.playerSession.lastGameCheck = now;
                
                if (!this.playerSession.inSession) {
                    // Start new session
                    this.playerSession.inSession = true;
                    this.playerSession.sessionStartTime = now;
                    this.playerSession.gameCount = 1;
                    await this.sendSessionStartNotification(summoner, currentGame);
                    console.log(`Session started for ${summoner.name}`);
                } else {
                    // Already in session, just update game count
                    this.playerSession.gameCount++;
                }
            } else {
                // Player not in ranked game
                if (this.playerSession.inSession && this.shouldEndSession()) {
                    // End session due to timeout
                    await this.sendSessionEndNotification(summoner);
                    this.resetSession();
                    console.log(`Session ended for ${summoner.name} due to inactivity`);
                }
            }
        } catch (error) {
            console.error(`Error checking player ${this.playerSession.summonerName}:`, error.message);
        }
    }

    resetSession() {
        this.playerSession.inSession = false;
        this.playerSession.sessionStartTime = null;
        this.playerSession.gameCount = 0;
        this.playerSession.lastGameCheck = null;
    }

    async sendSessionStartNotification(summoner, gameData) {
        try {
            const channel = await this.discordClient.channels.fetch(this.playerSession.channelId);
            const rankInfo = await this.riotApi.getRankInfo(summoner.id);
            const formattedRank = this.riotApi.formatRankInfo(rankInfo);
            
            const embed = {
                color: 0x00ff00,
                title: '🎮 Gaming Session Started!',
                description: `**${summoner.name}** started a ranked solo queue session!`,
                fields: [
                    {
                        name: 'Current Rank',
                        value: formattedRank,
                        inline: true
                    },
                    {
                        name: 'Session Start',
                        value: `<t:${Math.floor(this.playerSession.sessionStartTime.getTime() / 1000)}:t>`,
                        inline: true
                    }
                ],
                timestamp: new Date(),
                footer: {
                    text: 'LoL Paparazzi'
                }
            };

            await channel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Error sending session start notification:', error);
        }
    }

    async sendSessionEndNotification(summoner) {
        try {
            const channel = await this.discordClient.channels.fetch(this.playerSession.channelId);
            const sessionDuration = Math.floor((new Date() - this.playerSession.sessionStartTime) / 1000 / 60); // minutes
            
            const embed = {
                color: 0xff9900,
                title: '⏹️ Gaming Session Ended',
                description: `**${summoner.name}**'s gaming session has ended!`,
                fields: [
                    {
                        name: 'Session Duration',
                        value: `${sessionDuration} minutes`,
                        inline: true
                    },
                    {
                        name: 'Games Played',
                        value: this.playerSession.gameCount.toString(),
                        inline: true
                    }
                ],
                timestamp: new Date(),
                footer: {
                    text: 'LoL Paparazzi'
                }
            };

            await channel.send({ embeds: [embed] });
        } catch (error) {
            console.error('Error sending session end notification:', error);
        }
    }

    startTracking() {
        if (this.cronJob) {
            this.cronJob.destroy();
        }

        // Check every 2 minutes (Riot API personal key limit is 100 requests per 2 minutes)
        // This gives us plenty of buffer for other API calls (summoner lookup, rank info, etc.)
        this.cronJob = cron.schedule('*/2 * * * *', async () => {
            if (!this.playerSession.summonerName) return;

            console.log(`Checking ${this.playerSession.summonerName}...`);
            await this.checkPlayer();
        });

        console.log('Player tracking started (checking every 2 minutes)');
    }

    stopTracking() {
        if (this.cronJob) {
            this.cronJob.destroy();
            this.cronJob = null;
        }
        console.log('Player tracking stopped');
    }
}

module.exports = PlayerTracker;