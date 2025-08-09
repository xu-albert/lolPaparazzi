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
            pendingMatchAnalysis: [],
            // LP and session tracking
            sessionStartLP: null,
            currentLP: null,
            sessionGames: [], // Array of game results with LP changes
            // Refined session timing - based on actual gameplay not detection
            firstGameStartTime: null, // When first match actually began
            lastGameEndTime: null,   // When last match actually ended
            sessionStats: {
                wins: 0,
                losses: 0,
                lpGained: 0,
                champions: {},
                bestGame: null,
                worstGame: null
            }
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
            // Process pending match analysis queue
            await this.processPendingMatchAnalysis();
            
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
                    
                    // Queue this game for match analysis using persistent queue
                    this.playerSession.lastCompletedGameId = this.playerSession.currentGameId;
                    this.playerSession.currentGameId = null;
                    
                    // Add to persistent queue with 30-second delay (match data may take time to appear)
                    await this.persistence.queueMatchAnalysis(summoner, this.playerSession.lastCompletedGameId, 0.5);
                    
                    // Save updated session state
                    await this.persistence.saveTrackingData(this.playerSession);
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
        // Reset LP and session tracking
        this.playerSession.sessionStartLP = null;
        this.playerSession.currentLP = null;
        this.playerSession.sessionGames = [];
        // Reset refined session timing
        this.playerSession.firstGameStartTime = null;
        this.playerSession.lastGameEndTime = null;
        this.playerSession.sessionStats = {
            wins: 0,
            losses: 0,
            lpGained: 0,
            champions: {},
            bestGame: null,
            worstGame: null
        };
    }

    async sendSessionStartNotification(summoner, gameData) {
        try {
            const channel = await this.discordClient.channels.fetch(this.playerSession.channelId);
            const rankInfo = await this.riotApi.getRankInfo(summoner.puuid);
            const formattedRank = this.riotApi.formatRankInfo(rankInfo);
            
            // Capture starting LP for session tracking
            const soloRank = rankInfo.find(entry => entry.queueType === 'RANKED_SOLO_5x5');
            if (soloRank) {
                this.playerSession.sessionStartLP = soloRank.leaguePoints;
                this.playerSession.currentLP = soloRank.leaguePoints;
                console.log(`📊 Session starting LP: ${soloRank.leaguePoints}`);
            }
            
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
            await this.sendComprehensiveSessionSummary(summoner, channel);
        } catch (error) {
            console.error('Error sending session end notification:', error);
        }
    }

    async sendComprehensiveSessionSummary(summoner, channel) {
        try {
            // Calculate session span using refined timing (first game start to last game end)
            let sessionSpanMinutes = 0;
            let durationText = 'No games tracked';
            
            if (this.playerSession.firstGameStartTime && this.playerSession.lastGameEndTime) {
                sessionSpanMinutes = Math.floor((this.playerSession.lastGameEndTime - this.playerSession.firstGameStartTime) / 1000 / 60);
                const hours = Math.floor(sessionSpanMinutes / 60);
                const minutes = sessionSpanMinutes % 60;
                durationText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
                console.log(`📊 Refined session duration: ${durationText} (from ${this.playerSession.firstGameStartTime.toISOString()} to ${this.playerSession.lastGameEndTime.toISOString()})`);
            }
            
            const stats = this.playerSession.sessionStats;
            const totalGames = stats.wins + stats.losses;
            const winrate = totalGames > 0 ? Math.round((stats.wins / totalGames) * 100) : 0;
            
            // Calculate LP change
            let lpSummary = '';
            if (this.playerSession.sessionStartLP !== null && this.playerSession.currentLP !== null) {
                const totalLPChange = this.playerSession.currentLP - this.playerSession.sessionStartLP;
                const lpEmoji = totalLPChange > 0 ? '📈' : totalLPChange < 0 ? '📉' : '➖';
                const lpChangeText = totalLPChange > 0 ? `+${totalLPChange}` : `${totalLPChange}`;
                lpSummary = `${lpEmoji} ${lpChangeText} LP net gain`;
            }
            
            // Build champion summary
            let championSummary = '';
            const championEntries = Object.entries(stats.champions)
                .sort(([,a], [,b]) => b.games - a.games)
                .slice(0, 3);
                
            championSummary = championEntries.map(([champ, data]) => 
                `${champ} (${data.games} games) - ${data.wins}W-${data.losses}L`
            ).join('\n') || 'No games tracked';
            
            // Build performance highlights
            let highlights = '';
            if (stats.bestGame) {
                highlights += `🥇 Best Game: ${stats.bestGame.kda} KDA ${stats.bestGame.champion}`;
                if (stats.bestGame.lpChange) {
                    highlights += ` (${stats.bestGame.lpChange > 0 ? '+' : ''}${stats.bestGame.lpChange} LP)`;
                }
            }
            
            const embed = {
                color: winrate >= 50 ? 0x00ff00 : 0xff9900,
                title: '📊 Session Complete',
                description: `**${summoner.gameName}#${summoner.tagLine}** • ${durationText} • ${totalGames} Games Played`,
                fields: [
                    {
                        name: '🏆 PERFORMANCE',
                        value: `${stats.wins > 0 ? '✅' : '❌'} ${stats.wins}W-${stats.losses}L (${winrate}% WR)\n${lpSummary}`,
                        inline: false
                    },
                    {
                        name: '🎮 CHAMPIONS',
                        value: championSummary,
                        inline: false
                    }
                ],
                timestamp: new Date(),
                footer: {
                    text: 'LoL Paparazzi'
                }
            };
            
            // Add performance highlights if available
            if (highlights) {
                embed.fields.push({
                    name: '📈 HIGHLIGHTS',
                    value: highlights,
                    inline: false
                });
            }
            
            await channel.send({ embeds: [embed] });
            console.log(`📊 Sent comprehensive session summary: ${stats.wins}W-${stats.losses}L, ${stats.lpGained > 0 ? '+' : ''}${stats.lpGained} LP`);
            
        } catch (error) {
            console.error('Error sending comprehensive session summary:', error);
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

    async sendPostGameNotification(summoner, matchStats, lpChange = null) {
        try {
            const channel = await this.discordClient.channels.fetch(this.playerSession.channelId);
            
            // Color based on win/loss
            const embedColor = matchStats.win ? 0x00ff00 : 0xff0000; // Green for win, red for loss
            const resultEmoji = matchStats.win ? '🟢' : '🔴';
            const resultText = matchStats.win ? 'VICTORY' : 'DEFEAT';
            
            // Create op.gg URL
            const opggUrl = this.riotApi.createOpGGUrl(summoner.gameName, summoner.tagLine, matchStats.matchId);
            
            // Champion image URL from Data Dragon
            const championImageUrl = `https://ddragon.leagueoflegends.com/cdn/14.1.1/img/champion/${matchStats.championName}.png`;
            
            // Build LP change text
            let lpText = '';
            if (lpChange) {
                const lpChangeText = lpChange.change > 0 ? `+${lpChange.change}` : `${lpChange.change}`;
                const lpEmoji = lpChange.change > 0 ? '📈' : '📉';
                lpText = `${lpEmoji} ${lpChangeText} LP (${lpChange.current} LP)`;
            }
            
            const embed = {
                color: embedColor,
                title: `🎮 Game ${this.playerSession.gameCount} Complete - ${resultText}!`,
                description: `**${summoner.gameName}#${summoner.tagLine}** • ${matchStats.championName}`,
                thumbnail: {
                    url: championImageUrl
                },
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
                    }
                ],
                timestamp: new Date(),
                footer: {
                    text: 'LoL Paparazzi'
                }
            };
            
            // Add LP field if available
            if (lpText) {
                embed.fields.push({
                    name: 'LP Change',
                    value: lpText,
                    inline: true
                });
            }
            
            // Add op.gg link
            embed.fields.push({
                name: 'Match Details',
                value: `[View on op.gg](${opggUrl})`,
                inline: false
            });

            await channel.send({ embeds: [embed] });
            console.log(`Sent post-game notification: ${resultText} for ${summoner.gameName}#${summoner.tagLine}`);
            
        } catch (error) {
            console.error('Error sending post-game notification:', error);
        }
    }

    async processPendingMatchAnalysis() {
        try {
            const pendingAnalysis = await this.persistence.getPendingMatchAnalysis();
            
            for (const analysis of pendingAnalysis) {
                try {
                    console.log(`Processing queued match analysis (ID: ${analysis.id})`);
                    
                    const summonerData = analysis.summonerData;
                    const success = await this.analyzeQueuedMatch(summonerData, analysis.gameId);
                    
                    if (success) {
                        await this.persistence.markAnalysisComplete(analysis.id);
                    } else {
                        // Retry if not too many attempts
                        if (analysis.retryCount < 2) {
                            await this.persistence.markAnalysisRetry(analysis.id);
                        } else {
                            console.log(`Max retries reached for analysis ID: ${analysis.id}`);
                            await this.persistence.markAnalysisComplete(analysis.id); // Remove failed analysis
                        }
                    }
                } catch (error) {
                    console.error(`Error processing analysis ID ${analysis.id}:`, error);
                    await this.persistence.markAnalysisRetry(analysis.id);
                }
            }
            
            // Periodic cleanup of old entries
            if (Math.random() < 0.1) { // 10% chance each check
                await this.persistence.cleanupOldAnalysis();
            }
        } catch (error) {
            console.error('Error processing pending match analysis:', error);
        }
    }

    async analyzeQueuedMatch(summonerData, gameId = null) {
        try {
            console.log(`Analyzing queued match for ${summonerData.gameName}#${summonerData.tagLine}`);
            
            // Get recent match history to find our completed game
            const matchIds = await this.riotApi.getMatchHistory(summonerData.puuid, this.playerSession.sessionStartTime, 3);
            
            if (matchIds.length === 0) {
                console.log('No recent matches found - match data may not be available yet');
                return false; // Will retry later
            }
            
            // Find the most recent match (should be our completed game)
            const mostRecentMatchId = matchIds[0];
            console.log(`Fetching details for match: ${mostRecentMatchId}`);
            
            const matchData = await this.riotApi.getMatchDetails(mostRecentMatchId);
            if (!matchData) {
                console.log('Failed to fetch match details');
                return false; // Will retry later
            }
            
            // Extract player stats from the match
            const playerStats = await this.riotApi.getPlayerMatchStats(matchData, summonerData.puuid);
            if (!playerStats) {
                console.log('Failed to extract player stats from match');
                return false; // Will retry later
            }
            
            // Calculate LP change
            const lpChange = await this.calculateLPChange(summonerData, playerStats);
            
            // Update session statistics with match data for timing
            await this.updateSessionStats(playerStats, lpChange, matchData);
            
            // Send post-game notification with LP data
            await this.sendPostGameNotification(summonerData, playerStats, lpChange);
            return true; // Success
            
        } catch (error) {
            console.error('Error analyzing queued match:', error);
            return false; // Will retry later
        }
    }

    async calculateLPChange(summonerData, playerStats) {
        try {
            // Get current rank info after the game
            const currentRankInfo = await this.riotApi.getRankInfo(summonerData.puuid);
            const soloRank = currentRankInfo.find(entry => entry.queueType === 'RANKED_SOLO_5x5');
            
            if (!soloRank || this.playerSession.currentLP === null) {
                console.log('Unable to calculate LP change - missing rank data');
                return null;
            }
            
            const newLP = soloRank.leaguePoints;
            const lpChange = newLP - this.playerSession.currentLP;
            
            // Update current LP
            this.playerSession.currentLP = newLP;
            
            console.log(`💰 LP Change: ${lpChange > 0 ? '+' : ''}${lpChange} (${this.playerSession.currentLP} LP total)`);
            
            return {
                change: lpChange,
                previous: this.playerSession.currentLP - lpChange,
                current: this.playerSession.currentLP,
                tier: soloRank.tier,
                rank: soloRank.rank
            };
        } catch (error) {
            console.error('Error calculating LP change:', error);
            return null;
        }
    }

    async updateSessionStats(playerStats, lpChange, matchData = null) {
        try {
            // Update session timing with actual game start/end times
            if (matchData) {
                const gameStartTime = new Date(matchData.info.gameStartTimestamp);
                const gameEndTime = new Date(matchData.info.gameEndTimestamp);
                
                // Track first game start time
                if (!this.playerSession.firstGameStartTime) {
                    this.playerSession.firstGameStartTime = gameStartTime;
                    console.log(`🎯 Session first game started: ${gameStartTime.toISOString()}`);
                }
                
                // Always update last game end time
                this.playerSession.lastGameEndTime = gameEndTime;
                console.log(`🏁 Session last game ended: ${gameEndTime.toISOString()}`);
            }
            
            // Update win/loss counts
            if (playerStats.win) {
                this.playerSession.sessionStats.wins++;
            } else {
                this.playerSession.sessionStats.losses++;
            }
            
            // Update LP gained/lost
            if (lpChange) {
                this.playerSession.sessionStats.lpGained += lpChange.change;
            }
            
            // Update champion stats
            const champion = playerStats.championName;
            if (!this.playerSession.sessionStats.champions[champion]) {
                this.playerSession.sessionStats.champions[champion] = {
                    games: 0,
                    wins: 0,
                    losses: 0
                };
            }
            
            this.playerSession.sessionStats.champions[champion].games++;
            if (playerStats.win) {
                this.playerSession.sessionStats.champions[champion].wins++;
            } else {
                this.playerSession.sessionStats.champions[champion].losses++;
            }
            
            // Track best/worst games by KDA
            const kdaValue = playerStats.kda === 'Perfect' ? 99 : parseFloat(playerStats.kda);
            const gameData = {
                champion: champion,
                kda: playerStats.kda,
                kdaValue: kdaValue,
                result: playerStats.win ? 'W' : 'L',
                lpChange: lpChange ? lpChange.change : 0
            };
            
            if (!this.playerSession.sessionStats.bestGame || kdaValue > this.playerSession.sessionStats.bestGame.kdaValue) {
                this.playerSession.sessionStats.bestGame = gameData;
            }
            
            if (!this.playerSession.sessionStats.worstGame || kdaValue < this.playerSession.sessionStats.worstGame.kdaValue) {
                this.playerSession.sessionStats.worstGame = gameData;
            }
            
            // Store detailed game data
            this.playerSession.sessionGames.push({
                champion: champion,
                win: playerStats.win,
                kda: playerStats.kda,
                cs: playerStats.cs,
                csPerMin: playerStats.csPerMin,
                duration: playerStats.gameDuration,
                lpChange: lpChange ? lpChange.change : 0
            });
            
            console.log(`📊 Session stats updated: ${this.playerSession.sessionStats.wins}W-${this.playerSession.sessionStats.losses}L, ${this.playerSession.sessionStats.lpGained > 0 ? '+' : ''}${this.playerSession.sessionStats.lpGained} LP`);
            
        } catch (error) {
            console.error('Error updating session stats:', error);
        }
    }

    // Enhanced session metrics for accurate /info display
    async getEnhancedSessionMetrics() {
        try {
            if (!this.playerSession.originalInput) {
                return {
                    isTracking: false,
                    status: 'Not tracking any player',
                    statusEmoji: '❌'
                };
            }

            const summoner = await this.riotApi.getSummonerByName(this.playerSession.originalInput);
            const currentGame = await this.riotApi.getCurrentGame(summoner.puuid);
            const isInRankedGame = currentGame && this.riotApi.isRankedSoloGame(currentGame);
            
            // Calculate accurate completed games count
            const completedGames = this.playerSession.sessionGames ? this.playerSession.sessionGames.length : 0;
            const totalGames = completedGames + (isInRankedGame ? 1 : 0);
            
            // Calculate session duration using refined timing
            let sessionDuration = 0;
            let durationText = 'No session active';
            
            if (this.playerSession.inSession) {
                if (isInRankedGame) {
                    // Player is in game - use current game start time if available
                    if (currentGame.gameStartTime) {
                        const gameStart = new Date(currentGame.gameStartTime);
                        sessionDuration = Math.floor((new Date() - gameStart) / 1000 / 60);
                        durationText = `${sessionDuration}min (current game)`;
                    } else if (this.playerSession.firstGameStartTime) {
                        sessionDuration = Math.floor((new Date() - this.playerSession.firstGameStartTime) / 1000 / 60);
                        durationText = `${sessionDuration}min`;
                    }
                } else if (this.playerSession.firstGameStartTime && this.playerSession.lastGameEndTime) {
                    // Between games - show total session span
                    sessionDuration = Math.floor((this.playerSession.lastGameEndTime - this.playerSession.firstGameStartTime) / 1000 / 60);
                    const timeSinceLastGame = Math.floor((new Date() - this.playerSession.lastGameEndTime) / 1000 / 60);
                    durationText = `${sessionDuration}min session (${timeSinceLastGame}min ago)`;
                } else if (this.playerSession.firstGameStartTime) {
                    // Fallback to first game start time
                    sessionDuration = Math.floor((new Date() - this.playerSession.firstGameStartTime) / 1000 / 60);
                    durationText = `${sessionDuration}min`;
                }
            }
            
            // Determine status and emoji
            let status, statusEmoji;
            if (isInRankedGame) {
                const gameTime = currentGame.gameLength ? Math.floor(currentGame.gameLength / 60) : 'Unknown';
                // Get champion from participant data if available
                const participant = currentGame.participants?.find(p => p.puuid === summoner.puuid);
                const champion = participant ? participant.championName : 'Unknown Champion';
                status = `Playing Ranked Solo (${champion}) - ${gameTime}min`;
                statusEmoji = '🎮';
            } else if (this.playerSession.inSession && completedGames > 0) {
                status = `Between Games (${completedGames} completed)`;
                statusEmoji = '⏸️';
            } else if (this.playerSession.inSession) {
                status = 'Session Starting';
                statusEmoji = '🎯';
            } else {
                status = 'Not Playing';
                statusEmoji = '💤';
            }
            
            return {
                isTracking: true,
                status,
                statusEmoji,
                completedGames,
                totalGames,
                sessionDuration,
                durationText,
                isInGame: isInRankedGame,
                currentGame,
                sessionStats: this.playerSession.sessionStats,
                sessionStartLP: this.playerSession.sessionStartLP,
                currentLP: this.playerSession.currentLP
            };
            
        } catch (error) {
            console.error('Error getting enhanced session metrics:', error);
            return {
                isTracking: true,
                status: 'Error fetching status',
                statusEmoji: '❌',
                error: error.message
            };
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
                
                // Restore refined session timing and LP tracking
                this.playerSession.firstGameStartTime = savedData.firstGameStartTime;
                this.playerSession.lastGameEndTime = savedData.lastGameEndTime;
                this.playerSession.sessionStartLP = savedData.sessionStartLP;
                this.playerSession.currentLP = savedData.currentLP;
                
                console.log(`🔄 Restored tracking: ${savedData.summonerName} in channel ${savedData.channelId}`);
                
                if (this.playerSession.inSession) {
                    const sessionDuration = Math.floor((new Date() - this.playerSession.sessionStartTime) / 1000 / 60);
                    console.log(`🎮 Resumed active session: ${this.playerSession.gameCount} games, ${sessionDuration} minutes`);
                    
                    // Check for game completion during downtime
                    await this.checkForMissedGameCompletion();
                    
                    // Immediately check current game state to minimize downtime
                    await this.checkPlayer();
                }
            } else {
                console.log('ℹ️ No tracking data to restore');
            }
        } catch (error) {
            console.error('Error restoring tracking data:', error.message);
        }
    }

    async checkForMissedGameCompletion() {
        try {
            // If we had a currentGameId when we shut down, check if that game completed
            if (this.playerSession.currentGameId && this.playerSession.originalInput) {
                console.log(`🔍 Checking for missed game completion during downtime...`);
                
                const summoner = await this.riotApi.getSummonerByName(this.playerSession.originalInput);
                const currentGame = await this.riotApi.getCurrentGame(summoner.puuid);
                
                // If player is not in game now, but we had a game ID saved, that game completed during downtime
                if (!currentGame || !this.riotApi.isRankedSoloGame(currentGame)) {
                    console.log(`🎮 Detected missed game completion: ${this.playerSession.currentGameId}`);
                    
                    // Queue the completed game for analysis
                    this.playerSession.lastCompletedGameId = this.playerSession.currentGameId;
                    this.playerSession.currentGameId = null;
                    
                    await this.persistence.queueMatchAnalysis(summoner, this.playerSession.lastCompletedGameId, 0.1); // Quick analysis
                    await this.persistence.saveTrackingData(this.playerSession);
                    
                    console.log(`📝 Queued missed game for analysis`);
                }
            }
        } catch (error) {
            console.error('Error checking for missed game completion:', error);
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