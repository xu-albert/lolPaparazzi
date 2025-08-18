const cron = require('node-cron');
const PersistenceManager = require('./persistence');

class DailyTracker {
    constructor(riotApi, discordClient) {
        this.riotApi = riotApi;
        this.discordClient = discordClient;
        this.persistence = new PersistenceManager();
        
        // Track players by channel - Map of channelId -> playerData
        this.trackedPlayers = new Map();
        
        // Daily tracking data - Map of channelId -> dailyData
        this.dailyData = new Map();
        
        // Polling configuration
        this.cronJob = null;
        this.pollingInterval = '*/3 * * * *'; // Check every 3 minutes
        
        // Schedule daily summary at midnight
        this.dailySummaryJob = null;
        
        // Rate limiting for /info command
        this.infoCommandCooldowns = new Map();
        this.liveDataCache = {
            data: null,
            timestamp: null,
            expiresIn: 15000
        };
    }

    async setPlayer(channelId, summonerName, originalInput = null) {
        const playerData = {
            summonerName,
            channelId,
            originalInput: originalInput || summonerName,
            currentGameId: null,
            lastCompletedGameId: null,
            lastGameCheck: null
        };
        
        this.trackedPlayers.set(channelId, playerData);
        console.log(`Now tracking ${summonerName} in channel ${channelId}`);
        
        // Initialize or load today's daily data
        await this.initializeDailyData(channelId, playerData);
    }

    async initializeDailyData(channelId, playerData) {
        try {
            const summoner = await this.riotApi.getSummonerByName(playerData.originalInput);
            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
            
            // Check if we already have daily data for today
            let dailyTracking = await this.persistence.getDailyTracking(channelId, summoner.puuid, today);
            
            if (!dailyTracking) {
                // Get current rank info for starting LP
                const rankInfo = await this.riotApi.getRankInfo(summoner.puuid);
                const soloRank = rankInfo.find(entry => entry.queueType === 'RANKED_SOLO_5x5');
                
                const summonerData = {
                    puuid: summoner.puuid,
                    gameName: summoner.gameName,
                    tagLine: summoner.tagLine,
                    currentLP: soloRank ? soloRank.leaguePoints : 0,
                    currentTier: soloRank ? soloRank.tier : null,
                    currentRank: soloRank ? soloRank.rank : null
                };
                
                // Create new daily tracking record
                const dailyTrackingId = await this.persistence.createOrUpdateDailyTracking(
                    channelId,
                    summonerData,
                    today
                );
                
                dailyTracking = {
                    id: dailyTrackingId,
                    date: today,
                    startLP: summonerData.currentLP,
                    currentLP: summonerData.currentLP,
                    startTier: summonerData.currentTier,
                    startRank: summonerData.currentRank,
                    currentTier: summonerData.currentTier,
                    currentRank: summonerData.currentRank
                };
            }
            
            // Initialize daily stats
            const dailyStats = {
                dailyTrackingId: dailyTracking.id,
                date: today,
                summoner: summoner,
                startLP: dailyTracking.startLP || dailyTracking.start_lp,
                currentLP: dailyTracking.currentLP || dailyTracking.end_lp || dailyTracking.start_lp,
                startTier: dailyTracking.startTier || dailyTracking.start_tier,
                startRank: dailyTracking.startRank || dailyTracking.start_rank,
                currentTier: dailyTracking.currentTier || dailyTracking.end_tier || dailyTracking.start_tier,
                currentRank: dailyTracking.currentRank || dailyTracking.end_rank || dailyTracking.start_rank,
                gamesPlayed: 0,
                wins: 0,
                losses: 0,
                casualGames: 0,
                totalLPChange: 0,
                firstGameTime: null,
                lastGameTime: null,
                championStats: {},
                bestGame: null,
                worstGame: null,
                games: []
            };
            
            this.dailyData.set(channelId, dailyStats);
            console.log(`📅 Initialized daily tracking for ${summoner.gameName}#${summoner.tagLine} on ${today}`);
            
        } catch (error) {
            console.error('Error initializing daily data:', error);
        }
    }

    async checkPlayer() {
        if (this.trackedPlayers.size === 0) return;
        
        try {
            // Process pending match analysis
            await this.processPendingMatchAnalysis();
            
            // Check each tracked player
            for (const [channelId, playerData] of this.trackedPlayers) {
                await this.checkPlayerStatus(channelId, playerData);
            }
        } catch (error) {
            console.error('Error in checkPlayer:', error);
        }
    }

    async checkPlayerStatus(channelId, playerData) {
        try {
            const summoner = await this.riotApi.getSummonerByName(playerData.originalInput);
            const currentGame = await this.riotApi.getCurrentGame(summoner.puuid);
            const now = new Date();
            
            // Ensure we have today's daily data
            await this.checkAndResetDailyData(channelId, playerData);
            
            if (currentGame && this.riotApi.isRankedSoloGame(currentGame)) {
                playerData.lastGameCheck = now;
                
                const gameId = currentGame.gameId;
                const isNewGame = gameId !== playerData.currentGameId;
                
                if (isNewGame) {
                    console.log(`🎮 New ranked game detected for ${summoner.gameName}#${summoner.tagLine}`);
                    playerData.currentGameId = gameId;
                    
                    // Send game start notification with prediction panel
                    await this.sendGameStartNotification(summoner, currentGame, channelId);
                }
            } else if (currentGame && this.riotApi.isCasualGame(currentGame)) {
                // Track casual games
                const gameId = currentGame.gameId;
                const isNewGame = gameId !== playerData.currentGameId;
                
                if (isNewGame) {
                    playerData.currentGameId = gameId;
                    const dailyStats = this.dailyData.get(channelId);
                    if (dailyStats) {
                        dailyStats.casualGames++;
                        console.log(`🎮 Casual game detected (${dailyStats.casualGames} today)`);
                    }
                }
            } else {
                // Not in game - check if a game just ended
                if (playerData.currentGameId) {
                    console.log(`Game ended: ${playerData.currentGameId}`);
                    playerData.lastCompletedGameId = playerData.currentGameId;
                    playerData.currentGameId = null;
                    
                    // Queue for match analysis
                    await this.persistence.queueMatchAnalysis(summoner, playerData.lastCompletedGameId, 0.5);
                }
            }
        } catch (error) {
            console.error(`Error checking player ${playerData.summonerName}:`, error);
        }
    }

    async checkAndResetDailyData(channelId, playerData) {
        const today = new Date().toISOString().split('T')[0];
        const dailyStats = this.dailyData.get(channelId);
        
        // If date changed or no daily data, initialize new day
        if (!dailyStats || dailyStats.date !== today) {
            // Send daily summary for previous day if exists
            if (dailyStats && dailyStats.gamesPlayed > 0) {
                await this.sendDailySummary(channelId, dailyStats);
            }
            
            // Initialize new day's data
            await this.initializeDailyData(channelId, playerData);
        }
    }

    async sendGameStartNotification(summoner, gameData, channelId) {
        try {
            const channel = await this.discordClient.channels.fetch(channelId);
            const dailyStats = this.dailyData.get(channelId);
            
            if (!dailyStats.firstGameTime) {
                dailyStats.firstGameTime = new Date();
            }
            
            // Create prediction panel if betting manager is available
            if (this.bettingManager && gameData) {
                console.log('🎯 Creating prediction panel for new game...');
                
                try {
                    const gameAnalysis = await this.riotApi.analyzeCurrentGame(summoner, gameData);
                    const predictionPanel = await this.bettingManager.createEnhancedPredictionPanel(gameAnalysis);
                    
                    if (!predictionPanel) {
                        console.log(`🎯 Prediction panel already exists for game ${gameData.gameId}`);
                        return;
                    }
                    
                    // Send the prediction panel with role ping
                    let content = '🎯 **NEW GAME STARTED - PREDICTIONS OPEN!** 🎯';
                    const guild = channel.guild;
                    if (guild) {
                        const paparazziRole = guild.roles.cache.find(role => role.name === 'Paparazzi');
                        if (paparazziRole) {
                            content = `<@&${paparazziRole.id}> ${content}`;
                        }
                    }
                    
                    const message = await channel.send({
                        content,
                        ...predictionPanel
                    });
                    
                    // Save panel to prevent duplicates
                    await this.persistence.saveBettingPanel(
                        gameData.gameId,
                        message.id,
                        channel.id,
                        summoner.puuid,
                        gameData.gameStartTime ? new Date(gameData.gameStartTime) : new Date()
                    );
                    
                    // Track the panel for timer updates
                    this.bettingManager.setBettingPanel(
                        gameData.gameId,
                        message.id,
                        channel.id,
                        Date.now()
                    );
                    
                    console.log(`✅ Prediction panel created for game ${gameData.gameId}`);
                } catch (error) {
                    console.error('Error creating prediction panel:', error);
                }
            }
        } catch (error) {
            console.error('Error sending game start notification:', error);
        }
    }

    async processPendingMatchAnalysis() {
        try {
            const pendingAnalysis = await this.persistence.getPendingMatchAnalysis();
            
            for (const analysis of pendingAnalysis) {
                try {
                    const success = await this.analyzeQueuedMatch(analysis.summonerData, analysis.gameId);
                    
                    if (success) {
                        await this.persistence.markAnalysisComplete(analysis.id);
                    } else {
                        if (analysis.retryCount < 2) {
                            await this.persistence.markAnalysisRetry(analysis.id);
                        } else {
                            await this.persistence.markAnalysisComplete(analysis.id);
                        }
                    }
                } catch (error) {
                    console.error(`Error processing analysis ID ${analysis.id}:`, error);
                    await this.persistence.markAnalysisRetry(analysis.id);
                }
            }
            
            // Cleanup old entries periodically
            if (Math.random() < 0.1) {
                await this.persistence.cleanupOldAnalysis();
            }
        } catch (error) {
            console.error('Error processing pending match analysis:', error);
        }
    }

    async analyzeQueuedMatch(summonerData, gameId = null) {
        try {
            console.log(`Analyzing match for ${summonerData.gameName}#${summonerData.tagLine}`);
            
            // Find the channel for this summoner
            let targetChannelId = null;
            let dailyStats = null;
            
            for (const [channelId, stats] of this.dailyData) {
                if (stats.summoner && stats.summoner.puuid === summonerData.puuid) {
                    targetChannelId = channelId;
                    dailyStats = stats;
                    break;
                }
            }
            
            if (!targetChannelId || !dailyStats) {
                console.log('No active daily tracking found for this summoner');
                return false;
            }
            
            // Get match history
            const matchIds = await this.riotApi.getMatchHistory(summonerData.puuid, new Date(Date.now() - 24*60*60*1000), 3);
            
            if (matchIds.length === 0) {
                console.log('No recent matches found');
                return false;
            }
            
            const mostRecentMatchId = matchIds[0];
            const matchData = await this.riotApi.getMatchDetails(mostRecentMatchId);
            
            if (!matchData) {
                console.log('Failed to fetch match details');
                return false;
            }
            
            const playerStats = await this.riotApi.getPlayerMatchStats(matchData, summonerData.puuid);
            
            if (!playerStats) {
                console.log('Failed to extract player stats');
                return false;
            }
            
            // Calculate LP change
            const lpChange = await this.calculateLPChange(summonerData, playerStats, dailyStats);
            
            // Update daily stats
            await this.updateDailyStats(dailyStats, playerStats, lpChange, matchData);
            
            // Resolve predictions if betting manager is available
            if (this.bettingManager && gameId) {
                try {
                    const actualOutcome = playerStats.win ? 'win' : 'loss';
                    const predictionResults = await this.bettingManager.resolvePredictions(gameId, actualOutcome, mostRecentMatchId);
                    
                    if (predictionResults.length > 0) {
                        await this.sendPredictionResults(predictionResults, summonerData, playerStats, targetChannelId);
                    }
                } catch (error) {
                    console.error('Error resolving predictions:', error);
                }
            }
            
            // Send post-game notification
            await this.sendPostGameNotification(summonerData, playerStats, lpChange, targetChannelId);
            
            return true;
        } catch (error) {
            console.error('Error analyzing queued match:', error);
            return false;
        }
    }

    async calculateLPChange(summonerData, playerStats, dailyStats) {
        try {
            const currentRankInfo = await this.riotApi.getRankInfo(summonerData.puuid);
            const soloRank = currentRankInfo.find(entry => entry.queueType === 'RANKED_SOLO_5x5');
            
            if (!soloRank || dailyStats.currentLP === null) {
                return null;
            }
            
            const newLP = soloRank.leaguePoints;
            const newTier = soloRank.tier;
            const newRank = soloRank.rank;
            
            const previousLP = dailyStats.currentLP;
            const previousTier = dailyStats.currentTier;
            const previousRank = dailyStats.currentRank;
            
            let lpChange = 0;
            const apexTiers = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];
            const isApexTier = apexTiers.includes(newTier) || (previousTier && apexTiers.includes(previousTier));
            
            // Check for rank changes
            let rankChanged = false;
            if (previousTier && (previousRank !== undefined)) {
                if (isApexTier) {
                    rankChanged = (previousTier !== newTier);
                } else {
                    rankChanged = (previousTier !== newTier) || (previousRank !== newRank);
                }
            }
            
            if (rankChanged) {
                // Estimate LP for rank changes
                if (playerStats.win) {
                    lpChange = Math.floor(Math.random() * 11) + 15; // 15-25 LP
                } else {
                    lpChange = -(Math.floor(Math.random() * 11) + 15); // -15 to -25 LP
                }
            } else {
                lpChange = newLP - previousLP;
            }
            
            // Update daily stats with new LP
            dailyStats.currentLP = newLP;
            dailyStats.currentTier = newTier;
            dailyStats.currentRank = newRank;
            dailyStats.totalLPChange = newLP - dailyStats.startLP;
            
            return {
                change: lpChange,
                previous: previousLP,
                current: newLP,
                tier: newTier,
                rank: newRank,
                rankChanged: rankChanged,
                previousTier: previousTier,
                previousRank: previousRank
            };
        } catch (error) {
            console.error('Error calculating LP change:', error);
            return null;
        }
    }

    async updateDailyStats(dailyStats, playerStats, lpChange, matchData) {
        try {
            // Update game counts
            dailyStats.gamesPlayed++;
            if (playerStats.win) {
                dailyStats.wins++;
            } else {
                dailyStats.losses++;
            }
            
            // Update timing
            dailyStats.lastGameTime = new Date(matchData.info.gameEndTimestamp);
            
            // Update champion stats
            const champion = playerStats.championName;
            if (!dailyStats.championStats[champion]) {
                dailyStats.championStats[champion] = {
                    games: 0,
                    wins: 0,
                    losses: 0
                };
            }
            
            dailyStats.championStats[champion].games++;
            if (playerStats.win) {
                dailyStats.championStats[champion].wins++;
            } else {
                dailyStats.championStats[champion].losses++;
            }
            
            // Track best/worst games
            const kdaValue = playerStats.kda === 'Perfect' ? 99 : parseFloat(playerStats.kda);
            const gameData = {
                champion: champion,
                kda: playerStats.kda,
                kdaValue: kdaValue,
                result: playerStats.win ? 'W' : 'L',
                lpChange: lpChange ? lpChange.change : 0,
                matchId: playerStats.matchId
            };
            
            if (!dailyStats.bestGame || kdaValue > dailyStats.bestGame.kdaValue) {
                dailyStats.bestGame = gameData;
            }
            
            if (!dailyStats.worstGame || kdaValue < dailyStats.worstGame.kdaValue) {
                dailyStats.worstGame = gameData;
            }
            
            // Save game to database
            if (dailyStats.dailyTrackingId) {
                await this.persistence.saveDailyGame(dailyStats.dailyTrackingId, playerStats, matchData);
                
                // Update daily tracking record
                await this.persistence.updateDailyStats(dailyStats.dailyTrackingId, {
                    gamesPlayed: dailyStats.gamesPlayed,
                    wins: dailyStats.wins,
                    losses: dailyStats.losses,
                    casualGames: dailyStats.casualGames,
                    totalLPChange: dailyStats.totalLPChange,
                    endLP: dailyStats.currentLP,
                    endTier: dailyStats.currentTier,
                    endRank: dailyStats.currentRank,
                    firstGameTime: dailyStats.firstGameTime,
                    lastGameTime: dailyStats.lastGameTime,
                    championStats: dailyStats.championStats,
                    bestGame: dailyStats.bestGame,
                    worstGame: dailyStats.worstGame
                });
            }
            
            dailyStats.games.push(gameData);
            console.log(`📊 Updated daily stats: ${dailyStats.wins}W-${dailyStats.losses}L`);
            
        } catch (error) {
            console.error('Error updating daily stats:', error);
        }
    }

    async sendPostGameNotification(summoner, matchStats, lpChange, channelId) {
        try {
            const channel = await this.discordClient.channels.fetch(channelId);
            const dailyStats = this.dailyData.get(channelId);
            
            const embedColor = matchStats.win ? 0x00ff00 : 0xff0000;
            const resultEmoji = matchStats.win ? '🟢' : '🔴';
            const resultText = matchStats.win ? 'VICTORY' : 'DEFEAT';
            
            const opggUrl = this.riotApi.createOpGGUrl(summoner.gameName, summoner.tagLine, matchStats.matchId);
            const championImageUrl = `https://ddragon.leagueoflegends.com/cdn/14.1.1/img/champion/${matchStats.championName}.png`;
            
            // Include game count for the day
            const gameNumber = dailyStats ? dailyStats.gamesPlayed : 1;
            
            let lpText = '';
            if (lpChange && matchStats.win && lpChange.change > 0) {
                lpText = `📈 +${lpChange.change} LP (${lpChange.current} LP)`;
            }
            
            const embed = {
                color: embedColor,
                title: `🎮 Today's Game #${gameNumber} - ${resultText}!`,
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
                    text: `Daily: ${dailyStats.wins}W-${dailyStats.losses}L`
                }
            };
            
            if (lpText) {
                embed.fields.push({
                    name: 'LP Change',
                    value: lpText,
                    inline: true
                });
            }
            
            embed.fields.push({
                name: 'Match History',
                value: `[View on op.gg](${opggUrl})`,
                inline: false
            });

            await channel.send({ embeds: [embed] });
            console.log(`Sent post-game notification for ${summoner.gameName}#${summoner.tagLine}`);
            
        } catch (error) {
            console.error('Error sending post-game notification:', error);
        }
    }

    async sendPredictionResults(predictionResults, summonerData, playerStats, channelId) {
        try {
            const channel = await this.discordClient.channels.fetch(channelId);
            
            const correctPredictions = predictionResults.filter(r => r.wasCorrect);
            const incorrectPredictions = predictionResults.filter(r => !r.wasCorrect);
            
            const resultEmoji = playerStats.win ? '🎉' : '💔';
            const outcomeText = playerStats.win ? 'VICTORY' : 'DEFEAT';
            
            let resultText = `${resultEmoji} **PREDICTION RESULTS - ${outcomeText}**\n`;
            resultText += `${summonerData.gameName}#${summonerData.tagLine} (${playerStats.championName})\n\n`;
            
            if (correctPredictions.length > 0) {
                resultText += `🎯 **CORRECT PREDICTIONS:**\n`;
                for (const correct of correctPredictions) {
                    resultText += `<@${correct.userId}> ✅ Predicted ${correct.predictedOutcome.toUpperCase()}\n`;
                }
                resultText += '\n';
            }
            
            if (incorrectPredictions.length > 0) {
                resultText += `❌ **INCORRECT PREDICTIONS:**\n`;
                for (const incorrect of incorrectPredictions) {
                    resultText += `<@${incorrect.userId}> ❌ Predicted ${incorrect.predictedOutcome.toUpperCase()}\n`;
                }
            }
            
            await channel.send(resultText);
            console.log(`✅ Sent prediction results to channel ${channelId}`);
        } catch (error) {
            console.error('Error sending prediction results:', error);
        }
    }

    async sendDailySummary(channelId, dailyStats = null) {
        try {
            const channel = await this.discordClient.channels.fetch(channelId);
            
            if (!dailyStats) {
                dailyStats = this.dailyData.get(channelId);
            }
            
            if (!dailyStats || dailyStats.gamesPlayed === 0) {
                console.log('No games to summarize for daily report');
                return;
            }
            
            const totalGames = dailyStats.gamesPlayed;
            const winrate = totalGames > 0 ? Math.round((dailyStats.wins / totalGames) * 100) : 0;
            
            // Calculate LP summary
            let lpSummary = '';
            if (dailyStats.totalLPChange > 0) {
                lpSummary = `📈 +${dailyStats.totalLPChange} LP gained`;
            } else if (dailyStats.totalLPChange < 0) {
                lpSummary = `📉 ${dailyStats.totalLPChange} LP lost`;
            } else {
                lpSummary = '➖ No LP change';
            }
            
            // Build champion summary
            const championEntries = Object.entries(dailyStats.championStats)
                .sort(([,a], [,b]) => b.games - a.games)
                .slice(0, 3);
            
            const championSummary = championEntries.map(([champ, data]) =>
                `${champ} (${data.games} games) - ${data.wins}W-${data.losses}L`
            ).join('\n') || 'No games tracked';
            
            // Build highlights
            let highlights = '';
            if (dailyStats.bestGame) {
                highlights += `🥇 Best: ${dailyStats.bestGame.kda} KDA on ${dailyStats.bestGame.champion}`;
            }
            
            // Calculate play time
            let playTime = '';
            if (dailyStats.firstGameTime && dailyStats.lastGameTime) {
                const timeDiff = dailyStats.lastGameTime - dailyStats.firstGameTime;
                const hours = Math.floor(timeDiff / (1000 * 60 * 60));
                const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
                playTime = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
            }
            
            const embed = {
                color: 0x5865f2,
                title: `📊 Daily Summary - ${dailyStats.date}`,
                description: `**${dailyStats.summoner.gameName}#${dailyStats.summoner.tagLine}**`,
                fields: [
                    {
                        name: '🎮 GAMES',
                        value: `${totalGames} ranked${dailyStats.casualGames > 0 ? `, ${dailyStats.casualGames} casual` : ''}`,
                        inline: true
                    },
                    {
                        name: '⏱️ PLAY TIME',
                        value: playTime || 'N/A',
                        inline: true
                    },
                    {
                        name: '🏆 PERFORMANCE',
                        value: `${dailyStats.wins}W-${dailyStats.losses}L (${winrate}% WR)\n${lpSummary}`,
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
                    text: 'LoL Paparazzi Daily Report'
                }
            };
            
            if (highlights) {
                embed.fields.push({
                    name: '📈 HIGHLIGHTS',
                    value: highlights,
                    inline: false
                });
            }
            
            await channel.send({ embeds: [embed] });
            console.log(`📊 Sent daily summary for ${dailyStats.summoner.gameName}#${dailyStats.summoner.tagLine}`);
            
        } catch (error) {
            console.error('Error sending daily summary:', error);
        }
    }

    async startTracking() {
        // Schedule regular checks
        this.scheduleNextCheck();
        
        // Schedule daily summary at midnight
        this.scheduleDailySummary();
        
        console.log('Daily tracking started');
    }

    scheduleNextCheck() {
        if (this.cronJob) {
            this.cronJob.stop();
        }

        this.cronJob = cron.schedule(this.pollingInterval, async () => {
            if (this.trackedPlayers.size === 0) return;
            console.log(`Checking ${this.trackedPlayers.size} tracked players...`);
            await this.checkPlayer();
        });

        console.log('Player tracking scheduled (every 3 minutes)');
    }

    scheduleDailySummary() {
        if (this.dailySummaryJob) {
            this.dailySummaryJob.stop();
        }

        // Run at midnight every day
        this.dailySummaryJob = cron.schedule('0 0 * * *', async () => {
            console.log('🌙 Running daily summary at midnight...');
            
            for (const [channelId, dailyStats] of this.dailyData) {
                if (dailyStats.gamesPlayed > 0) {
                    await this.sendDailySummary(channelId, dailyStats);
                }
            }
            
            // Clear daily data for new day
            this.dailyData.clear();
            
            // Re-initialize for tracked players
            for (const [channelId, playerData] of this.trackedPlayers) {
                await this.initializeDailyData(channelId, playerData);
            }
            
            // Cleanup old daily data (keep 30 days)
            await this.persistence.cleanupOldDailyData(30);
        });

        console.log('Daily summary scheduled for midnight');
    }

    stopTracking() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.cronJob = null;
        }
        
        if (this.dailySummaryJob) {
            this.dailySummaryJob.stop();
            this.dailySummaryJob = null;
        }
        
        console.log('Daily tracking stopped');
    }

    // Get tracker for a specific channel
    getTrackerForChannel(channelId) {
        return this.trackedPlayers.get(channelId);
    }

    // Remove tracking for a channel
    removeTracking(channelId) {
        this.trackedPlayers.delete(channelId);
        this.dailyData.delete(channelId);
        console.log(`Removed tracking for channel ${channelId}`);
    }
}

module.exports = DailyTracker;