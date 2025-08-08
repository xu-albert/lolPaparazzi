const cron = require('node-cron');
const PersistenceManager = require('./persistence');

class PlayerTracker {
    constructor(riotApi, discordClient) {
        this.riotApi = riotApi;
        this.discordClient = discordClient;
        this.persistence = new PersistenceManager();
        this.playerSession = {
            summonerName: null,
            channelId: null,
            inSession: false,
            lastGameCheck: null,
            sessionStartTime: null,
            gameCount: 0,
            currentGameId: null,
            lastCompletedGameId: null,
            pendingMatchAnalysis: []
        };
        this.cronJob = null;
        // Session ends after 15 minutes of no ranked games
        this.sessionTimeoutMinutes = 15;
        // Different polling intervals based on session state
        this.normalPollingInterval = '*/3 * * * *'; // Every 3 minutes when not in session
        this.inGamePollingInterval = '*/5 * * * *'; // Every 5 minutes during session
    }

    setPlayer(channelId, summonerName, originalInput = null) {
        this.playerSession.channelId = channelId;
        this.playerSession.summonerName = summonerName;
        this.playerSession.originalInput = originalInput || summonerName;
        console.log(`Now tracking ${summonerName} in channel ${channelId}`);
        
        // Save tracking data
        this.persistence.saveTrackingData(this.playerSession);
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
        if (!this.playerSession.originalInput) return;
        
        try {
            const summoner = await this.riotApi.getSummonerByName(this.playerSession.originalInput);
            const currentGame = await this.riotApi.getCurrentGame(summoner.puuid);
            const now = new Date();
            
            if (currentGame && this.riotApi.isRankedSoloGame(currentGame)) {
                // Player is in a ranked game
                this.playerSession.lastGameCheck = now;
                
                // Check if this is a new game (different game ID)
                const gameId = currentGame.gameId;
                const isNewGame = gameId !== this.playerSession.currentGameId;
                
                if (!this.playerSession.inSession) {
                    // Start new session
                    this.playerSession.inSession = true;
                    this.playerSession.sessionStartTime = now;
                    this.playerSession.gameCount = 1;
                    this.playerSession.currentGameId = gameId;
                    await this.sendSessionStartNotification(summoner, currentGame);
                    console.log(`Session started for ${summoner.gameName}#${summoner.tagLine}`);
                    // Save session state to database
                    await this.persistence.saveTrackingData(this.playerSession);
                    // Switch to longer polling interval during session
                    this.scheduleNextCheck();
                } else if (isNewGame) {
                    // Already in session, but this is a new game
                    this.playerSession.gameCount++;
                    this.playerSession.currentGameId = gameId;
                    console.log(`New game detected for ${summoner.gameName}#${summoner.tagLine} (Game ${this.playerSession.gameCount})`);
                    // Save updated game count to database
                    await this.persistence.saveTrackingData(this.playerSession);
                }
                // If same game, don't increment counter
            } else {
                // Player not in ranked game - check if a game just ended
                if (this.playerSession.inSession && this.playerSession.currentGameId) {
                    // Player was in a game but now isn't - game ended!
                    console.log(`Game ended: ${this.playerSession.currentGameId} for ${summoner.gameName}#${summoner.tagLine}`);
                    
                    // Queue this game for match analysis
                    this.playerSession.lastCompletedGameId = this.playerSession.currentGameId;
                    this.playerSession.currentGameId = null;
                    
                    // Analyze match after a short delay (match data may take time to appear)
                    setTimeout(() => {
                        this.analyzeCompletedMatch(summoner);
                    }, 30000); // 30 second delay
                }
                
                if (this.playerSession.inSession && this.shouldEndSession()) {
                    // End session due to timeout
                    await this.sendSessionEndNotification(summoner);
                    this.resetSession();
                    console.log(`Session ended for ${summoner.gameName}#${summoner.tagLine} due to inactivity`);
                    // Save cleared session state to database
                    await this.persistence.saveTrackingData(this.playerSession);
                    // Switch back to faster polling when not in session
                    this.scheduleNextCheck();
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
        this.playerSession.currentGameId = null;
        this.playerSession.lastCompletedGameId = null;
        this.playerSession.pendingMatchAnalysis = [];
    }

    async sendSessionStartNotification(summoner, gameData) {
        try {
            const channel = await this.discordClient.channels.fetch(this.playerSession.channelId);
            const rankInfo = await this.riotApi.getRankInfo(summoner.puuid);
            const formattedRank = this.riotApi.formatRankInfo(rankInfo);
            
            const embed = {
                color: 0x00ff00,
                title: '🎮 Gaming Session Started!',
                description: `**${summoner.gameName}#${summoner.tagLine}** started a ranked solo queue session!`,
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

            // Find the Paparazzi role and ping it (only once per session)
            let content = '';
            const guild = channel.guild;
            if (guild) {
                const paparazziRole = guild.roles.cache.find(role => role.name === 'Paparazzi');
                if (paparazziRole) {
                    content = `<@&${paparazziRole.id}>`;
                    console.log('Pinging Paparazzi role for session start');
                }
            }

            await channel.send({ content, embeds: [embed] });
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
                description: `**${summoner.gameName}#${summoner.tagLine}**'s gaming session has ended!`,
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

    async analyzeCompletedMatch(summoner) {
        try {
            console.log(`Analyzing completed match for ${summoner.gameName}#${summoner.tagLine}`);
            
            // Get recent match history to find our completed game
            const matchIds = await this.riotApi.getMatchHistory(summoner.puuid, this.playerSession.sessionStartTime, 3);
            
            if (matchIds.length === 0) {
                console.log('No recent matches found - match data may not be available yet');
                return;
            }
            
            // Find the most recent match (should be our completed game)
            const mostRecentMatchId = matchIds[0];
            console.log(`Fetching details for match: ${mostRecentMatchId}`);
            
            const matchData = await this.riotApi.getMatchDetails(mostRecentMatchId);
            if (!matchData) {
                console.log('Failed to fetch match details');
                return;
            }
            
            // Extract player stats from the match
            const playerStats = await this.riotApi.getPlayerMatchStats(matchData, summoner.puuid);
            if (!playerStats) {
                console.log('Failed to extract player stats from match');
                return;
            }
            
            // Send post-game notification
            await this.sendPostGameNotification(summoner, playerStats);
            
        } catch (error) {
            console.error('Error analyzing completed match:', error);
        }
    }

    async sendPostGameNotification(summoner, matchStats) {
        try {
            const channel = await this.discordClient.channels.fetch(this.playerSession.channelId);
            
            // Color based on win/loss
            const embedColor = matchStats.win ? 0x00ff00 : 0xff0000; // Green for win, red for loss
            const resultEmoji = matchStats.win ? '🟢' : '🔴';
            const resultText = matchStats.win ? 'VICTORY' : 'DEFEAT';
            
            // Create op.gg URL
            const opggUrl = this.riotApi.createOpGGUrl(summoner.gameName, summoner.tagLine, matchStats.matchId);
            
            const embed = {
                color: embedColor,
                title: `🎮 Game ${this.playerSession.gameCount} Complete - ${resultText}!`,
                description: `**${summoner.gameName}#${summoner.tagLine}** • ${matchStats.championName}`,
                fields: [
                    {
                        name: 'KDA',
                        value: `${matchStats.kills}/${matchStats.deaths}/${matchStats.assists} (${matchStats.kda} KDA)`,
                        inline: true
                    },
                    {
                        name: 'CS/min',
                        value: `${matchStats.csPerMin}/min (${matchStats.cs} total)`,
                        inline: true
                    },
                    {
                        name: 'Duration',
                        value: matchStats.gameDuration,
                        inline: true
                    },
                    {
                        name: 'Match Details',
                        value: `[View on op.gg](${opggUrl})`,
                        inline: false
                    }
                ],
                timestamp: new Date(),
                footer: {
                    text: 'LoL Paparazzi'
                }
            };

            await channel.send({ embeds: [embed] });
            console.log(`Sent post-game notification: ${resultText} for ${summoner.gameName}#${summoner.tagLine}`);
            
        } catch (error) {
            console.error('Error sending post-game notification:', error);
        }
    }

    async startTracking() {
        // Try to restore tracking data from previous session
        await this.restoreTrackingData();
        this.scheduleNextCheck();
    }

    async restoreTrackingData() {
        try {
            console.log('🔍 Attempting to restore tracking data...');
            const savedData = await this.persistence.loadTrackingData();
            if (savedData && savedData.channelId && savedData.summonerName) {
                // Restore basic tracking info
                this.playerSession.channelId = savedData.channelId;
                this.playerSession.summonerName = savedData.summonerName;
                this.playerSession.originalInput = savedData.originalInput;
                
                // Restore session state
                this.playerSession.inSession = savedData.inSession || false;
                this.playerSession.sessionStartTime = savedData.sessionStartTime;
                this.playerSession.gameCount = savedData.gameCount || 0;
                this.playerSession.currentGameId = savedData.currentGameId;
                this.playerSession.lastGameCheck = savedData.lastGameCheck;
                this.playerSession.lastCompletedGameId = savedData.lastCompletedGameId;
                this.playerSession.pendingMatchAnalysis = []; // Always reset this on startup
                
                console.log(`🔄 Restored tracking: ${savedData.summonerName} in channel ${savedData.channelId}`);
                
                if (this.playerSession.inSession) {
                    const sessionDuration = Math.floor((new Date() - this.playerSession.sessionStartTime) / 1000 / 60);
                    console.log(`🎮 Resumed active session: ${this.playerSession.gameCount} games, ${sessionDuration} minutes`);
                }
            } else {
                console.log('ℹ️ No tracking data to restore');
            }
        } catch (error) {
            console.error('Error restoring tracking data:', error.message);
        }
    }

    scheduleNextCheck() {
        if (this.cronJob) {
            this.cronJob.destroy();
        }

        // Use different intervals based on session state
        const interval = this.playerSession.inSession ? this.inGamePollingInterval : this.normalPollingInterval;
        const intervalText = this.playerSession.inSession ? '5 minutes (in session)' : '3 minutes (idle)';

        this.cronJob = cron.schedule(interval, async () => {
            if (!this.playerSession.originalInput) return;

            console.log(`Checking ${this.playerSession.summonerName}... (${intervalText})`);
            await this.checkPlayer();
        });

        console.log(`Player tracking scheduled (${intervalText})`);
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