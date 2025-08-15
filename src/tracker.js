const cron = require('node-cron');
const PersistenceManager = require('./persistence');

class PlayerTracker {
    constructor(riotApi, discordClient) {
        this.riotApi = riotApi;
        this.discordClient = discordClient;
        this.persistence = new PersistenceManager();
        // Multiple channel support - Map of channelId -> sessionData
        this.playerSessions = new Map();
        // For backward compatibility, maintain a reference to the most recent active session
        this.playerSession = null;
        this.cronJob = null;
        // Session ends after 15 minutes of no ranked games
        this.sessionTimeoutMinutes = 15;
        // Different polling intervals based on session state
        this.normalPollingInterval = '*/3 * * * *'; // Every 3 minutes when not in session
        this.inGamePollingInterval = '*/5 * * * *'; // Every 5 minutes during session
        
        // Rate limiting and caching for /info command
        this.infoCommandCooldowns = new Map(); // userId -> lastCallTime
        this.liveDataCache = {
            data: null,
            timestamp: null,
            expiresIn: 15000 // Cache live data for 15 seconds
        };
    }

    async setPlayer(channelId, summonerName, originalInput = null) {
        // Create or update session for this specific channel
        const sessionData = {
            summonerName,
            channelId,
            originalInput: originalInput || summonerName,
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
            sessionGames: [],
            // Refined session timing - based on actual gameplay not detection
            firstGameStartTime: null,
            lastGameEndTime: null,
            sessionStats: {
                wins: 0,
                losses: 0,
                lpGained: 0,
                champions: {},
                bestGame: null,
                worstGame: null
            }
        };
        
        this.playerSessions.set(channelId, sessionData);
        // For backward compatibility, set as current session
        this.playerSession = sessionData;
        console.log(`Now tracking ${summonerName} in channel ${channelId}`);
        
        // Save tracking data and capture session ID
        const sessionId = await this.persistence.saveTrackingData(sessionData);
        if (sessionId) {
            sessionData.id = sessionId;
        }
    }

    isSessionActive(channelId = null) {
        if (channelId) {
            const session = this.playerSessions.get(channelId);
            return session ? session.inSession : false;
        }
        // For backward compatibility, check if any session is active
        for (const session of this.playerSessions.values()) {
            if (session.inSession) return true;
        }
        return false;
    }

    shouldEndSession(session) {
        if (!session || !session.inSession) return false;
        
        const now = new Date();
        const timeSinceLastGame = (now - session.lastGameCheck) / 1000 / 60; // minutes
        
        return timeSinceLastGame > this.sessionTimeoutMinutes;
    }
    
    getSessionForChannel(channelId) {
        return this.playerSessions.get(channelId);
    }
    
    removeSession(channelId) {
        const session = this.playerSessions.get(channelId);
        if (session) {
            this.playerSessions.delete(channelId);
            // If this was our current session reference, update it
            if (this.playerSession === session) {
                // Set to any remaining active session, or null
                this.playerSession = this.playerSessions.size > 0 ? 
                    this.playerSessions.values().next().value : null;
            }
            console.log(`Removed session for channel ${channelId}`);
        }
        return session;
    }

    async checkPlayer() {
        // Check all active sessions
        if (this.playerSessions.size === 0) return;
        
        try {
            // Process pending match analysis queue
            await this.processPendingMatchAnalysis();
            
            // Check each active session
            for (const [channelId, session] of this.playerSessions) {
                await this.checkSessionPlayer(channelId, session);
            }
        } catch (error) {
            console.error(`Error in checkPlayer:`, error.message);
        }
    }

    async checkSessionPlayer(channelId, session) {
        try {
            const summoner = await this.riotApi.getSummonerByName(session.originalInput);
            const currentGame = await this.riotApi.getCurrentGame(summoner.puuid);
            const now = new Date();
            
            // Debug logging for game detection
            if (currentGame) {
                console.log(`🎮 Channel ${channelId}: Game detected: ID=${currentGame.gameId}, Queue=${currentGame.gameQueueConfigId}, GameLength=${currentGame.gameLength || 'unknown'}s`);
                if (this.riotApi.isRankedSoloGame(currentGame)) {
                    console.log(`✅ Channel ${channelId}: Ranked solo game confirmed (Queue 420)`);
                } else {
                    console.log(`❌ Channel ${channelId}: Not ranked solo - Queue ${currentGame.gameQueueConfigId} (need 420)`);
                }
            } else {
                console.log(`❌ Channel ${channelId}: No active game found for ${summoner.gameName}#${summoner.tagLine}`);
            }
            
            if (currentGame && this.riotApi.isRankedSoloGame(currentGame)) {
                // Player is in a ranked game
                session.lastGameCheck = now;
                
                // Check if this is a new game (different game ID)
                const gameId = currentGame.gameId;
                const isNewGame = gameId !== session.currentGameId;
                
                console.log(`🔍 Channel ${channelId}: Session state: inSession=${session.inSession}, currentGameId=${session.currentGameId} (${typeof session.currentGameId}), newGameId=${gameId} (${typeof gameId}), isNewGame=${isNewGame}`);
                
                if (!session.inSession) {
                    console.log(`🚀 Channel ${channelId}: Starting new session for game ${gameId}`);
                    // Start new session
                    session.inSession = true;
                    session.sessionStartTime = now;
                    session.gameCount = 1;
                    session.currentGameId = gameId;
                    session.nonRankedGames = 0;
                    // Reset session data to ensure clean start
                    session.sessionGames = [];
                    session.sessionStats = {
                        wins: 0,
                        losses: 0,
                        lpGained: 0,
                        champions: {},
                        bestGame: null,
                        worstGame: null
                    };
                    await this.sendSessionStartNotification(summoner, currentGame, channelId);
                    console.log(`Session started for ${summoner.gameName}#${summoner.tagLine} in channel ${channelId}`);
                    // Save session state to database and capture session ID
                    const sessionId = await this.persistence.saveTrackingData(session);
                    if (sessionId) {
                        session.id = sessionId;
                    }
                    // Switch to longer polling interval during session
                    this.scheduleNextCheck();
                } else if (isNewGame) {
                    console.log(`🎮 Channel ${channelId}: New game detected for existing session: ${gameId}`);
                    // Already in session, but this is a new game
                    session.gameCount++;
                    session.currentGameId = gameId;
                    console.log(`New game detected for ${summoner.gameName}#${summoner.tagLine} in channel ${channelId} (Game ${session.gameCount})`);
                    
                    // Create betting panel for new game in existing session
                    await this.sendSessionStartNotification(summoner, currentGame, channelId);
                    
                    // Save updated game count to database and capture session ID
                    const sessionId = await this.persistence.saveTrackingData(session);
                    if (sessionId && !session.id) {
                        session.id = sessionId;
                    }
                } else {
                    console.log(`⏸️  Channel ${channelId}: Same game continues: ${gameId} (no action taken)`);
                }
                // If same game, don't increment counter
            } else if (currentGame && this.riotApi.isCasualGame(currentGame) && session.inSession) {
                // Player is in a casual game during an active ranked session
                session.lastGameCheck = now;
                
                // Check if this is a new casual game (different game ID)
                const gameId = currentGame.gameId;
                const isNewGame = gameId !== session.currentGameId;
                
                if (isNewGame) {
                    // Track this casual game
                    session.nonRankedGames = (session.nonRankedGames || 0) + 1;
                    session.currentGameId = gameId;
                    console.log(`Channel ${channelId}: New casual game detected for ${summoner.gameName}#${summoner.tagLine} (${session.nonRankedGames} casual games this session)`);
                    
                    // Save updated session state
                    await this.persistence.saveTrackingData(session);
                }
            } else {
                // Player not in ranked game - check if a game just ended
                if (session.inSession && session.currentGameId) {
                    // Player was in a game but now isn't - game ended!
                    console.log(`Channel ${channelId}: Game ended: ${session.currentGameId} for ${summoner.gameName}#${summoner.tagLine}`);
                    
                    // Queue this game for match analysis using persistent queue
                    session.lastCompletedGameId = session.currentGameId;
                    session.currentGameId = null;
                    
                    // Add to persistent queue with 30-second delay (match data may take time to appear)
                    await this.persistence.queueMatchAnalysis(summoner, session.lastCompletedGameId, 0.5);
                    
                    // Save updated session state
                    await this.persistence.saveTrackingData(session);
                }
                
                if (session.inSession && this.shouldEndSession(session)) {
                    // End session due to timeout
                    await this.sendSessionEndNotification(summoner, channelId);
                    this.resetSessionData(session);
                    console.log(`Session ended for ${summoner.gameName}#${summoner.tagLine} in channel ${channelId} due to inactivity`);
                    // Save cleared session state to database
                    await this.persistence.saveTrackingData(session);
                    // Switch back to faster polling when not in session
                    this.scheduleNextCheck();
                }
            }
        } catch (error) {
            console.error(`Error checking player ${session.summonerName} in channel ${channelId}:`, error.message);
        }
    }

    // Reset data for a specific session object
    resetSessionData(session) {
        session.inSession = false;
        session.sessionStartTime = null;
        session.gameCount = 0;
        session.nonRankedGames = 0;
        session.lastGameCheck = null;
        session.currentGameId = null;
        session.lastCompletedGameId = null;
        session.pendingMatchAnalysis = [];
        // Reset LP and session tracking
        session.sessionStartLP = null;
        session.currentLP = null;
        session.currentTier = null;
        session.currentRank = null;
        session.sessionGames = [];
        // Reset refined session timing
        session.firstGameStartTime = null;
        session.lastGameEndTime = null;
        session.sessionStats = {
            wins: 0,
            losses: 0,
            lpGained: 0,
            champions: {},
            bestGame: null,
            worstGame: null
        };
        // IMPORTANT: Reset session ID to ensure new sessions get new IDs
        session.id = null;
    }

    // For backward compatibility - resets the current session reference
    resetSession() {
        if (this.playerSession) {
            this.resetSessionData(this.playerSession);
        }
    }

    async sendSessionStartNotification(summoner, gameData, channelId) {
        try {
            const channel = await this.discordClient.channels.fetch(channelId);
            const session = this.playerSessions.get(channelId);
            const rankInfo = await this.riotApi.getRankInfo(summoner.puuid);
            const formattedRank = this.riotApi.formatRankInfo(rankInfo);
            
            // Capture starting LP and rank for session tracking
            const soloRank = rankInfo.find(entry => entry.queueType === 'RANKED_SOLO_5x5');
            if (soloRank && session) {
                session.sessionStartLP = soloRank.leaguePoints;
                session.currentLP = soloRank.leaguePoints;
                session.currentTier = soloRank.tier;
                session.currentRank = soloRank.rank; // null for Master+
                
                // Display rank properly for apex tiers
                const apexTiers = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];
                const displayRank = apexTiers.includes(soloRank.tier) ? soloRank.tier : `${soloRank.tier} ${soloRank.rank}`;
                console.log(`📊 Session starting: ${soloRank.leaguePoints} LP (${displayRank})`);
            }

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

            // Create and send betting panel if betting manager is available
            if (this.bettingManager && gameData) {
                console.log('🎯 Creating prediction panel for new game...');
                
                try {
                    // Analyze the current game for detailed prediction panel
                    const gameAnalysis = await this.riotApi.analyzeCurrentGame(summoner, gameData);
                    const predictionPanel = await this.bettingManager.createEnhancedPredictionPanel(gameAnalysis);
                    
                    // Check if panel was created (null means duplicate was prevented)
                    if (!predictionPanel) {
                        console.log(`🎯 Prediction panel already exists for game ${gameData.gameId} - skipping`);
                        return; // Skip sending duplicate panel
                    }
                    
                    // Send the prediction panel with Paparazzi role ping
                    let content = '🎯 **PREDICTIONS ARE NOW OPEN!** 🎯';
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
                    
                    // Save prediction panel to database (prevents future duplicates)
                    await this.persistence.saveBettingPanel(
                        gameData.gameId,
                        message.id,
                        channel.id,
                        summoner.puuid,
                        gameData.gameStartTime ? new Date(gameData.gameStartTime) : new Date()
                    );
                    
                    // Track the prediction panel for timer updates
                    this.bettingManager.setBettingPanel(
                        gameData.gameId, 
                        message.id, 
                        channel.id, 
                        Date.now()
                    );
                    
                    console.log(`✅ Prediction panel created and saved for game ${gameData.gameId}`);
                } catch (error) {
                    console.error('Error creating prediction panel:', error);
                    
                    // Send basic session start notification as fallback
                    const basicEmbed = {
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
                    
                    await channel.send({ content, embeds: [basicEmbed] });
                }
            } else {
                // Send basic session start notification if no betting manager
                const basicEmbed = {
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
                
                await channel.send({ content, embeds: [basicEmbed] });
            }
        } catch (error) {
            console.error('Error sending session start notification:', error);
        }
    }

    async sendSessionEndNotification(summoner, channelId) {
        try {
            const channel = await this.discordClient.channels.fetch(channelId);
            const session = this.playerSessions.get(channelId);
            await this.sendComprehensiveSessionSummary(summoner, channel, session);
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
            const casualGames = this.playerSession.nonRankedGames || 0;
            const winrate = totalGames > 0 ? Math.round((stats.wins / totalGames) * 100) : 0;
            
            // Calculate LP change - show both gains and losses accurately
            let lpSummary = '';
            if (this.playerSession.sessionStartLP !== null && this.playerSession.currentLP !== null) {
                const totalLPChange = this.playerSession.currentLP - this.playerSession.sessionStartLP;
                
                if (totalLPChange > 0) {
                    lpSummary = `📈 +${totalLPChange} LP gained`;
                } else if (totalLPChange < 0) {
                    lpSummary = `📉 ${totalLPChange} LP lost`;
                }
                // For neutral (0 LP change), don't show LP summary
            }
            
            // Build champion summary
            let championSummary = '';
            const championEntries = Object.entries(stats.champions)
                .sort(([,a], [,b]) => b.games - a.games)
                .slice(0, 3);
                
            championSummary = championEntries.map(([champ, data]) => 
                `${champ} (${data.games} games) - ${data.wins}W-${data.losses}L`
            ).join('\n') || 'No games tracked';
            
            // Build performance highlights - focus on gameplay performance, not LP
            let highlights = '';
            if (stats.bestGame) {
                highlights += `🥇 Best Game: ${stats.bestGame.kda} KDA on ${stats.bestGame.champion}`;
                // Removed LP display from highlights - keep focus on gameplay achievements
            }
            
            // Build game summary description
            let gamesSummary = '';
            if (totalGames > 0 && casualGames > 0) {
                gamesSummary = `${totalGames} ranked games, ${casualGames} casual games played`;
            } else if (totalGames > 0 && casualGames === 0) {
                gamesSummary = `${totalGames} ranked games played`;
            } else if (totalGames === 0 && casualGames > 0) {
                gamesSummary = `${casualGames} casual games played`;
            } else {
                gamesSummary = 'No games played';
            }

            const embed = {
                color: 0x5865f2, // Discord blue for all session summaries
                title: '📊 Session Complete',
                description: `**${summoner.gameName}#${summoner.tagLine}** • ${durationText} • ${gamesSummary}`,
                fields: [
                    {
                        name: '🏆 PERFORMANCE',
                        value: `${stats.wins > 0 ? '✅' : '❌'} ${stats.wins}W-${stats.losses}L (${winrate}% WR)${lpSummary ? '\n' + lpSummary : ''}`,
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
            
            // Build LP change text - only show for wins (positive feedback only)
            let lpText = '';
            if (lpChange && matchStats.win && lpChange.change > 0) {
                lpText = `📈 +${lpChange.change} LP (${lpChange.current} LP)`;
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
                name: 'Match History',
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
            
            // Resolve bets if betting manager is available
            if (this.bettingManager && gameId) {
                console.log('🎯 Resolving predictions for completed game...');
                try {
                    const actualOutcome = playerStats.win ? 'win' : 'loss';
                    const predictionResults = await this.bettingManager.resolvePredictions(gameId, actualOutcome, mostRecentMatchId);
                    
                    if (predictionResults.length > 0) {
                        await this.sendPredictionResults(predictionResults, summonerData, playerStats);
                    }
                } catch (error) {
                    console.error('Error resolving predictions:', error);
                }
            }
            
            // Send post-game notification with LP data
            await this.sendPostGameNotification(summonerData, playerStats, lpChange);
            return true; // Success
            
        } catch (error) {
            console.error('Error analyzing queued match:', error);
            return false; // Will retry later
        }
    }

    async sendPredictionResults(predictionResults, summonerData, playerStats) {
        try {
            console.log(`📊 Sending prediction results for ${predictionResults.length} predictions`);
            
            // Group results by channel for efficient messaging
            const resultsByChannel = new Map();
            predictionResults.forEach(result => {
                if (!resultsByChannel.has(result.channelId)) {
                    resultsByChannel.set(result.channelId, []);
                }
                resultsByChannel.get(result.channelId).push(result);
            });
            
            // Send results to each channel
            for (const [channelId, channelResults] of resultsByChannel) {
                try {
                    const channel = await this.discordClient.channels.fetch(channelId);
                    
                    // Create results summary
                    const correctPredictions = channelResults.filter(r => r.wasCorrect);
                    const incorrectPredictions = channelResults.filter(r => !r.wasCorrect);
                    
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
                    console.error(`Error sending prediction results to channel ${channelId}:`, error);
                }
            }
        } catch (error) {
            console.error('Error sending prediction results:', error);
        }
    }

    async calculateLPChange(summonerData, playerStats) {
        try {
            // Get current rank info after the game
            const currentRankInfo = await this.riotApi.getRankInfo(summonerData.puuid);
            const soloRank = currentRankInfo.find(entry => entry.queueType === 'RANKED_SOLO_5x5');
            
            if (!soloRank || this.playerSession.currentLP === null || this.playerSession.currentTier === null) {
                console.log('Unable to calculate LP change - missing rank data');
                return null;
            }
            
            const newLP = soloRank.leaguePoints;
            const newTier = soloRank.tier;
            const newRank = soloRank.rank;
            
            // Get previous rank info for comparison
            const previousLP = this.playerSession.currentLP;
            const previousTier = this.playerSession.currentTier;
            const previousRank = this.playerSession.currentRank;
            
            let lpChange = 0;
            
            // Define apex tiers (no divisions)
            const apexTiers = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];
            const isApexTier = apexTiers.includes(newTier) || (previousTier && apexTiers.includes(previousTier));
            
            // Check if rank/tier changed (promotion/demotion)
            let rankChanged = false;
            
            // Only check for rank changes if we have previous rank data
            if (previousTier && (previousRank !== undefined)) {
                if (isApexTier) {
                    // For apex tiers, only tier changes matter (no divisions)
                    rankChanged = (previousTier !== newTier);
                } else {
                    // For regular tiers, check both tier and division changes
                    rankChanged = (previousTier !== newTier) || (previousRank !== newRank);
                }
            }
            
            if (rankChanged) {
                const prevDisplay = isApexTier || !previousRank ? previousTier : `${previousTier} ${previousRank}`;
                const newDisplay = isApexTier || !newRank ? newTier : `${newTier} ${newRank}`;
                console.log(`🔄 Rank change detected: ${prevDisplay} → ${newDisplay}`);
                
                // For rank changes, we can't accurately calculate LP difference due to LP resets
                // Instead, we'll estimate based on win/loss and typical LP gains
                if (playerStats.win) {
                    // Win with promotion - estimate typical LP gain (15-25)
                    lpChange = Math.floor(Math.random() * 11) + 15; // 15-25 LP
                    console.log(`🎉 Promotion win detected, estimated +${lpChange} LP`);
                } else {
                    // Loss with demotion - estimate typical LP loss (15-25)
                    lpChange = -(Math.floor(Math.random() * 11) + 15); // -15 to -25 LP
                    console.log(`📉 Demotion loss detected, estimated ${lpChange} LP`);
                }
            } else {
                // Normal LP calculation when no rank change
                lpChange = newLP - previousLP;
            }
            
            // Update current LP and rank tracking
            this.playerSession.currentLP = newLP;
            this.playerSession.currentTier = newTier;
            this.playerSession.currentRank = newRank;
            
            // Display rank properly for apex tiers in logging
            const displayRank = apexTiers.includes(newTier) ? newTier : `${newTier} ${newRank}`;
            console.log(`💰 LP Change: ${lpChange > 0 ? '+' : ''}${lpChange} (${newLP} LP total, ${displayRank})`);
            
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
                lpChange: lpChange ? lpChange.change : 0,
                matchId: playerStats.matchId
            };
            
            if (!this.playerSession.sessionStats.bestGame || kdaValue > this.playerSession.sessionStats.bestGame.kdaValue) {
                this.playerSession.sessionStats.bestGame = gameData;
            }
            
            if (!this.playerSession.sessionStats.worstGame || kdaValue < this.playerSession.sessionStats.worstGame.kdaValue) {
                this.playerSession.sessionStats.worstGame = gameData;
            }
            
            // Store detailed game data
            const sessionGame = {
                championName: champion,
                win: playerStats.win,
                kda: playerStats.kda,
                kills: playerStats.kills,
                deaths: playerStats.deaths,
                assists: playerStats.assists,
                cs: playerStats.cs,
                csPerMin: playerStats.csPerMin,
                gameDuration: playerStats.gameDuration,
                lpChange: lpChange ? lpChange.change : 0,
                matchId: playerStats.matchId
            };
            
            this.playerSession.sessionGames.push(sessionGame);
            
            // Save individual game record to database if we have session data loaded
            if (this.playerSession.id && matchData) {
                await this.persistence.saveGameRecord(this.playerSession.id, sessionGame, matchData);
            }
            
            // Save updated session statistics to database
            if (this.playerSession.id) {
                await this.persistence.saveSessionStats(this.playerSession.id, this.playerSession.sessionStats);
            }
            
            console.log(`📊 Session stats updated: ${this.playerSession.sessionStats.wins}W-${this.playerSession.sessionStats.losses}L, ${this.playerSession.sessionStats.lpGained > 0 ? '+' : ''}${this.playerSession.sessionStats.lpGained} LP`);
            
        } catch (error) {
            console.error('Error updating session stats:', error);
        }
    }

    // Real-time session metrics with rate limiting for /info command
    async getRealTimeSessionMetrics(userId = null) {
        try {
            // Rate limiting: Allow each user to call this once every 30 seconds
            if (userId) {
                const now = Date.now();
                const lastCall = this.infoCommandCooldowns.get(userId);
                
                if (lastCall && (now - lastCall) < 30000) {
                    // User is rate limited, return cached data if available
                    if (this.liveDataCache.data && (now - this.liveDataCache.timestamp) < this.liveDataCache.expiresIn) {
                        console.log(`🚫 Rate limited user ${userId}, returning cached data`);
                        return this.liveDataCache.data;
                    }
                    
                    // If no cached data, allow the call but warn
                    console.log(`⚠️ Rate limited user ${userId} but no cached data, allowing call`);
                }
                
                this.infoCommandCooldowns.set(userId, now);
            }
            
            // Check if we have recent cached data (within 15 seconds)
            const now = Date.now();
            if (this.liveDataCache.data && (now - this.liveDataCache.timestamp) < this.liveDataCache.expiresIn) {
                console.log(`📋 Using cached live data (${Math.floor((now - this.liveDataCache.timestamp) / 1000)}s old)`);
                return this.liveDataCache.data;
            }
            
            // Fetch fresh data
            console.log(`🔄 Fetching real-time data for /info command`);
            const metrics = await this.fetchLiveSessionMetrics();
            
            // Cache the results
            this.liveDataCache = {
                data: metrics,
                timestamp: now,
                expiresIn: 15000
            };
            
            // If we got new live game data, reset polling timer to avoid redundant checks
            if (metrics.isInGame && metrics.currentGame) {
                console.log(`⏰ Resetting polling timer due to /info live data fetch`);
                this.scheduleNextCheck();
            }
            
            return metrics;
            
        } catch (error) {
            console.error('Error getting real-time session metrics:', error);
            return {
                isTracking: true,
                status: 'Error fetching live status',
                statusEmoji: '❌',
                error: error.message
            };
        }
    }

    // Core method to fetch live session metrics (used by both real-time and regular calls)
    async fetchLiveSessionMetrics() {
        try {
            if (!this.playerSession.originalInput) {
                return {
                    isTracking: false,
                    status: 'Not tracking any player',
                    statusEmoji: '❌'
                };
            }

            const summoner = await this.riotApi.getSummonerByName(this.playerSession.originalInput);
            // Bypass cache for user-initiated info commands to get fresh data
            const currentGame = await this.riotApi.getCurrentGame(summoner.puuid, true);
            const isInRankedGame = currentGame && this.riotApi.isRankedSoloGame(currentGame);
            
            // Calculate accurate completed games count
            const completedGames = this.playerSession.sessionGames ? this.playerSession.sessionGames.length : 0;
            const totalGames = completedGames + (isInRankedGame ? 1 : 0);
            
            // Calculate session duration with clear, user-friendly descriptions
            let sessionDuration = 0;
            let durationText = 'No session active';
            
            if (this.playerSession.inSession) {
                if (isInRankedGame) {
                    // Player is currently in a ranked game
                    if (currentGame.gameStartTime && currentGame.gameLength) {
                        // Use actual current game length from Riot API
                        sessionDuration = Math.floor(currentGame.gameLength / 60);
                        durationText = `${sessionDuration}min (current game)`;
                    } else if (currentGame.gameStartTime) {
                        // Fallback: calculate from game start time
                        const gameStart = new Date(currentGame.gameStartTime);
                        sessionDuration = Math.floor((new Date() - gameStart) / 1000 / 60);
                        durationText = `${sessionDuration}min (current game)`;
                    } else if (this.playerSession.firstGameStartTime) {
                        // Use session start as fallback
                        sessionDuration = Math.floor((new Date() - this.playerSession.firstGameStartTime) / 1000 / 60);
                        durationText = `${sessionDuration}min (current game)`;
                    }
                } else if (this.playerSession.lastGameEndTime) {
                    // Between games - show how long they've been idle
                    const timeSinceLastGame = Math.floor((new Date() - this.playerSession.lastGameEndTime) / 1000 / 60);
                    
                    // Calculate total session time for context
                    if (this.playerSession.firstGameStartTime) {
                        const totalSessionTime = Math.floor((this.playerSession.lastGameEndTime - this.playerSession.firstGameStartTime) / 1000 / 60);
                        durationText = `Idle for ${timeSinceLastGame}min (${totalSessionTime}min session)`;
                    } else {
                        durationText = `Idle for ${timeSinceLastGame}min`;
                    }
                } else if (this.playerSession.firstGameStartTime) {
                    // Session active but no last game end time (shouldn't happen, but fallback)
                    sessionDuration = Math.floor((new Date() - this.playerSession.firstGameStartTime) / 1000 / 60);
                    durationText = `${sessionDuration}min (session active)`;
                } else {
                    // Session just started
                    durationText = 'Session starting';
                }
            }
            
            // Determine status and emoji
            let status, statusEmoji, champion = null;
            if (isInRankedGame) {
                // Calculate current game time properly using real-time data
                let gameTimeText = 'Unknown';
                if (currentGame.gameLength) {
                    const gameMinutes = Math.floor(currentGame.gameLength / 60);
                    gameTimeText = `${gameMinutes}min`;
                }
                
                // Get champion from participant data (Spectator API uses 'participants' array)
                champion = 'Unknown Champion';
                if (currentGame.participants) {
                    const participant = currentGame.participants.find(p => p.puuid === summoner.puuid);
                    if (participant && participant.championId) {
                        // Spectator API uses championId (number), convert to name using Data Dragon
                        champion = await this.riotApi.getChampionNameById(participant.championId);
                    }
                }
                
                status = `Playing Ranked Solo (${champion}) - ${gameTimeText}`;
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
                currentChampion: champion,
                sessionStats: this.playerSession.sessionStats,
                sessionStartLP: this.playerSession.sessionStartLP,
                currentLP: this.playerSession.currentLP,
                realTimeFetch: true // Flag to indicate this was a real-time fetch
            };
            
        } catch (error) {
            console.error('Error fetching live session metrics:', error);
            return {
                isTracking: true,
                status: 'Error fetching status',
                statusEmoji: '❌',
                error: error.message
            };
        }
    }

    // Enhanced session metrics for accurate /info display (legacy method - now uses cached data)
    async getEnhancedSessionMetrics() {
        // For backward compatibility, just use the cached version without user ID
        return await this.getRealTimeSessionMetrics(null);
    }

    async startTracking() {
        // Try to restore tracking data from previous session
        await this.restoreTrackingData();
        this.scheduleNextCheck();
    }

    async restoreTrackingData() {
        try {
            console.log('🔍 Attempting to restore all tracking data...');
            this.playerSessions = await this.persistence.loadAllTrackingData();
            
            if (this.playerSessions.size > 0) {
                console.log(`📥 Restored ${this.playerSessions.size} active channel sessions`);
                // For backward compatibility, set playerSession to the first active session
                this.playerSession = this.playerSessions.values().next().value;
                
                // Log restored sessions
                for (const [channelId, session] of this.playerSessions) {
                    console.log(`🎮 Channel ${channelId}: Tracking ${session.summonerName} (Session: ${session.inSession ? 'active' : 'inactive'}, Games: ${session.gameCount || 0})`);
                }
            } else {
                console.log('ℹ️ No previous tracking sessions to restore');
                this.playerSession = null;
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
            this.cronJob.stop();
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
            this.cronJob.stop();
            this.cronJob = null;
        }
        console.log('Player tracking stopped');
    }
}

module.exports = PlayerTracker;