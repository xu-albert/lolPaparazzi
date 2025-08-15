const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

class BettingManager {
    constructor(persistence, riotApi) {
        console.log(`🎰 BettingManager instance created`);
        this.persistence = persistence;
        this.riotApi = riotApi;
        this.activeBettingPanels = new Map(); // gameId -> panel info
        this.bettingTimeouts = new Map(); // gameId -> timeout
    }

    // User prediction accuracy management
    async getUserPredictionStats(userId, guildId, channelId, trackedPlayerPuuid, trackedPlayerName) {
        if (!this.persistence.databaseAvailable) {
            return { 
                totalPredictions: 0, 
                correctPredictions: 0, 
                accuracy: 0, 
                currentStreak: 0, 
                bestStreak: 0 
            };
        }

        try {
            const result = await this.persistence.pool.query(`
                SELECT * FROM user_prediction_accuracy 
                WHERE user_id = $1 AND guild_id = $2 AND channel_id = $3 AND tracked_player_puuid = $4
            `, [userId, guildId, channelId, trackedPlayerPuuid]);

            if (result.rows.length === 0) {
                // Create new user accuracy record
                await this.persistence.pool.query(`
                    INSERT INTO user_prediction_accuracy 
                    (user_id, guild_id, channel_id, tracked_player_puuid, tracked_player_name)
                    VALUES ($1, $2, $3, $4, $5)
                `, [userId, guildId, channelId, trackedPlayerPuuid, trackedPlayerName]);
                
                return { 
                    totalPredictions: 0, 
                    correctPredictions: 0, 
                    accuracy: 0, 
                    currentStreak: 0, 
                    bestStreak: 0,
                    winPredictions: 0,
                    lossPredictions: 0,
                    isNewUser: true 
                };
            }

            const userData = result.rows[0];
            return {
                totalPredictions: userData.total_predictions,
                correctPredictions: userData.correct_predictions,
                accuracy: parseFloat(userData.accuracy_percentage),
                currentStreak: userData.current_streak,
                bestStreak: userData.best_streak,
                winPredictions: userData.win_predictions,
                lossPredictions: userData.loss_predictions,
                lastPrediction: userData.last_prediction_at
            };
        } catch (error) {
            console.error('Error getting user prediction stats:', error);
            return { 
                totalPredictions: 0, 
                correctPredictions: 0, 
                accuracy: 0, 
                currentStreak: 0, 
                bestStreak: 0,
                error: true 
            };
        }
    }

    // Get user prediction history for a specific tracked player
    async getUserPredictionHistory(userId, guildId, channelId, trackedPlayerPuuid, limit = 10) {
        if (!this.persistence.databaseAvailable) {
            return [];
        }

        try {
            const result = await this.persistence.pool.query(`
                SELECT predicted_outcome, actual_outcome, was_correct, match_id, created_at
                FROM prediction_history 
                WHERE user_id = $1 AND guild_id = $2 AND channel_id = $3 AND tracked_player_puuid = $4
                ORDER BY created_at DESC
                LIMIT $5
            `, [userId, guildId, channelId, trackedPlayerPuuid, limit]);

            return result.rows.map(row => ({
                predictedOutcome: row.predicted_outcome,
                actualOutcome: row.actual_outcome,
                wasCorrect: row.was_correct,
                matchId: row.match_id,
                date: row.created_at
            }));
        } catch (error) {
            console.error('Error getting user prediction history:', error);
            return [];
        }
    }

    async placePrediction(userId, guildId, gameId, playerPuuid, predictedOutcome, channelId, gameStartTime, trackedPlayerName) {
        if (!this.persistence.databaseAvailable) {
            return { success: false, message: 'Database not available' };
        }

        try {
            await this.persistence.pool.query('BEGIN');

            // Check if user already has a prediction on this game
            const existingPrediction = await this.persistence.pool.query(`
                SELECT id, predicted_outcome FROM active_predictions 
                WHERE user_id = $1 AND game_id = $2 AND status = 'active'
            `, [userId, gameId]);

            if (existingPrediction.rows.length > 0) {
                // Update existing prediction instead of rejecting
                const oldPrediction = existingPrediction.rows[0].predicted_outcome;
                
                // Update the prediction
                await this.persistence.pool.query(`
                    UPDATE active_predictions 
                    SET predicted_outcome = $3, created_at = CURRENT_TIMESTAMP
                    WHERE user_id = $1 AND game_id = $2
                `, [userId, gameId, predictedOutcome]);

                await this.persistence.pool.query('COMMIT');

                return { 
                    success: true, 
                    message: `Prediction updated! Now predicting ${predictedOutcome.toUpperCase()} (was ${oldPrediction.toUpperCase()})`
                };
            }

            // Place new prediction
            await this.persistence.pool.query(`
                INSERT INTO active_predictions (
                    user_id, guild_id, channel_id, game_id, tracked_player_puuid, 
                    tracked_player_name, predicted_outcome, game_start_time
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [userId, guildId, channelId, gameId, playerPuuid, trackedPlayerName, predictedOutcome, gameStartTime]);

            await this.persistence.pool.query('COMMIT');

            return { 
                success: true, 
                message: `Prediction placed! You predict ${predictedOutcome.toUpperCase()}`
            };
        } catch (error) {
            await this.persistence.pool.query('ROLLBACK');
            console.error('Error placing prediction:', error);
            
            // Provide more specific error messages
            if (error.message?.includes('foreign key') || error.message?.includes('constraint')) {
                return { success: false, message: 'Game no longer exists for predictions!' };
            } else if (error.message?.includes('connection') || error.message?.includes('pool')) {
                return { success: false, message: 'Database connection issue. Please try again!' };
            } else {
                return { success: false, message: 'Unable to place prediction. Please try again!' };
            }
        }
    }

    async resolvePredictions(gameId, actualOutcome, matchId = null) {
        if (!this.persistence.databaseAvailable) {
            console.log('⚠️ Cannot resolve predictions - database not available');
            return [];
        }

        try {
            console.log(`🎯 Resolving predictions for game ${gameId}, outcome: ${actualOutcome}`);
            
            await this.persistence.pool.query('BEGIN');

            // Get all active predictions for this game
            const activePredictions = await this.persistence.pool.query(`
                SELECT * FROM active_predictions 
                WHERE game_id = $1 AND status = 'active'
            `, [gameId]);

            const results = [];

            for (const prediction of activePredictions.rows) {
                const wasCorrect = prediction.predicted_outcome === actualOutcome;

                // Update user accuracy stats
                await this.updateUserAccuracy(
                    prediction.user_id, 
                    prediction.guild_id, 
                    prediction.channel_id,
                    prediction.tracked_player_puuid,
                    prediction.tracked_player_name,
                    wasCorrect,
                    prediction.predicted_outcome
                );

                // Mark prediction as resolved
                await this.persistence.pool.query(`
                    UPDATE active_predictions 
                    SET status = $2, resolved_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [prediction.id, wasCorrect ? 'correct' : 'incorrect']);

                // Add to prediction history
                await this.persistence.pool.query(`
                    INSERT INTO prediction_history (
                        user_id, guild_id, channel_id, tracked_player_puuid, tracked_player_name,
                        predicted_outcome, actual_outcome, was_correct, match_id, game_start_time
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `, [
                    prediction.user_id, prediction.guild_id, prediction.channel_id,
                    prediction.tracked_player_puuid, prediction.tracked_player_name,
                    prediction.predicted_outcome, actualOutcome, wasCorrect, matchId,
                    prediction.game_start_time
                ]);

                results.push({
                    userId: prediction.user_id,
                    predictedOutcome: prediction.predicted_outcome,
                    actualOutcome,
                    wasCorrect,
                    channelId: prediction.channel_id,
                    trackedPlayerName: prediction.tracked_player_name
                });
            }

            await this.persistence.pool.query('COMMIT');
            console.log(`✅ Resolved ${results.length} predictions for game ${gameId}`);
            
            return results;
        } catch (error) {
            await this.persistence.pool.query('ROLLBACK');
            console.error('Error resolving predictions:', error);
            return [];
        }
    }

    async updateUserAccuracy(userId, guildId, channelId, trackedPlayerPuuid, trackedPlayerName, wasCorrect, predictedOutcome) {
        try {
            // Get current stats
            const currentStats = await this.getUserPredictionStats(userId, guildId, channelId, trackedPlayerPuuid, trackedPlayerName);
            
            // Calculate new values
            const newTotalPredictions = currentStats.totalPredictions + 1;
            const newCorrectPredictions = currentStats.correctPredictions + (wasCorrect ? 1 : 0);
            const newAccuracy = (newCorrectPredictions / newTotalPredictions) * 100;
            
            // Update streak
            let newCurrentStreak = wasCorrect ? currentStats.currentStreak + 1 : 0;
            let newBestStreak = Math.max(currentStats.bestStreak, newCurrentStreak);
            
            // Update prediction type counts
            const newWinPredictions = currentStats.winPredictions + (predictedOutcome === 'win' ? 1 : 0);
            const newLossPredictions = currentStats.lossPredictions + (predictedOutcome === 'loss' ? 1 : 0);

            // Update database
            await this.persistence.pool.query(`
                UPDATE user_prediction_accuracy 
                SET total_predictions = $5,
                    correct_predictions = $6,
                    accuracy_percentage = $7,
                    win_predictions = $8,
                    loss_predictions = $9,
                    current_streak = $10,
                    best_streak = $11,
                    last_prediction_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $1 AND guild_id = $2 AND channel_id = $3 AND tracked_player_puuid = $4
            `, [
                userId, guildId, channelId, trackedPlayerPuuid,
                newTotalPredictions, newCorrectPredictions, newAccuracy,
                newWinPredictions, newLossPredictions, newCurrentStreak, newBestStreak
            ]);

        } catch (error) {
            console.error('Error updating user accuracy:', error);
        }
    }

    async expirePredictions(gameId) {
        if (!this.persistence.databaseAvailable) {
            return [];
        }

        try {
            // Get active predictions and mark them as expired
            const activePredictions = await this.persistence.pool.query(`
                SELECT * FROM active_predictions 
                WHERE game_id = $1 AND status = 'active'
            `, [gameId]);

            await this.persistence.pool.query('BEGIN');

            const expired = [];
            for (const prediction of activePredictions.rows) {
                // Mark prediction as expired (no refunds needed for accuracy system)
                await this.persistence.pool.query(`
                    UPDATE active_predictions 
                    SET status = 'expired', resolved_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [prediction.id]);

                expired.push({
                    userId: prediction.user_id,
                    predictedOutcome: prediction.predicted_outcome,
                    channelId: prediction.channel_id,
                    trackedPlayerName: prediction.tracked_player_name
                });
            }

            await this.persistence.pool.query('COMMIT');
            console.log(`🔄 Expired ${expired.length} predictions for game ${gameId}`);
            
            return expired;
        } catch (error) {
            await this.persistence.pool.query('ROLLBACK');
            console.error('Error expiring predictions:', error);
            return [];
        }
    }

    async getUserActivePredictions(userId, channelId = null) {
        if (!this.persistence.databaseAvailable) {
            return [];
        }

        try {
            let query = `
                SELECT * FROM active_predictions 
                WHERE user_id = $1 AND status = 'active'
            `;
            let params = [userId];

            if (channelId) {
                query += ` AND channel_id = $2`;
                params.push(channelId);
            }

            query += ` ORDER BY created_at DESC`;

            const result = await this.persistence.pool.query(query, params);
            return result.rows;
        } catch (error) {
            console.error('Error getting user active predictions:', error);
            return [];
        }
    }

    createPredictionButtons(gameId, disabled = false) {
        const predictionButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`predict_win_${gameId}`)
                .setLabel('🏆 PREDICT WIN')
                .setStyle(ButtonStyle.Success)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`predict_loss_${gameId}`)
                .setLabel('💀 PREDICT LOSS')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(disabled)
        );

        const utilityButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`accuracy_${gameId}`)
                .setLabel('📊 My Accuracy')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`leaderboard_${gameId}`)
                .setLabel('🏅 Leaderboard')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`stats_${gameId}`)
                .setLabel('📈 Game Stats')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disabled)
        );

        return [predictionButtons, utilityButtons];
    }

    // Store betting panel info for later updates
    setBettingPanel(gameId, messageId, channelId, startTime) {
        console.log(`🎰 Setting betting panel for game ${gameId} (${typeof gameId}) with 4-minute timer`);
        
        this.activeBettingPanels.set(gameId, {
            messageId,
            channelId,
            startTime,
            betsCount: 0
        });

        // Set 4-minute timeout to close betting
        const timeout = setTimeout(async () => {
            console.log(`⏰ Betting timer expired for game ${gameId}`);
            await this.closeBettingWindow(gameId);
        }, 4 * 60 * 1000);

        this.bettingTimeouts.set(gameId, timeout);
    }

    async closeBettingWindow(gameId) {
        const panelInfo = this.activeBettingPanels.get(gameId);
        if (!panelInfo) {
            console.log(`⚠️ closeBettingWindow called but no panel info for game ${gameId}`);
            return;
        }

        console.log(`🚫 Closing betting window for game ${gameId}`);
        
        // Clear timeout if it exists
        const timeout = this.bettingTimeouts.get(gameId);
        if (timeout) {
            clearTimeout(timeout);
            this.bettingTimeouts.delete(gameId);
        }

        // Remove from active panels
        console.log(`🗑️ Deleting betting panel info for game ${gameId}`);
        this.activeBettingPanels.delete(gameId);
    }

    getBettingTimeRemaining(gameId) {
        console.log(`🔍 Checking betting time for game ${gameId} (${typeof gameId}). Active panels: ${this.activeBettingPanels.size} total`);
        const panelInfo = this.activeBettingPanels.get(gameId);
        if (!panelInfo) {
            const activeKeys = Array.from(this.activeBettingPanels.keys());
            const keyTypes = activeKeys.map(k => `${k}(${typeof k})`);
            console.log(`⚠️ No betting panel info found for game ${gameId} (${typeof gameId}). Active panels: [${keyTypes.join(', ')}]`);
            return 0;
        }

        const elapsed = Date.now() - panelInfo.startTime;
        const remaining = Math.max(0, (4 * 60 * 1000) - elapsed);
        const remainingSeconds = Math.floor(remaining / 1000);
        
        console.log(`⏰ Betting timer check for game ${gameId}: ${remainingSeconds}s remaining (elapsed: ${Math.floor(elapsed/1000)}s)`);
        return remainingSeconds;
    }


    // Check if betting panel should be created (prevents duplicates)
    async shouldCreateBettingPanel(gameId) {
        try {
            // Check if we already sent a betting panel for this game
            const panelExists = await this.persistence.checkBettingPanelExists(gameId);
            if (panelExists) {
                console.log(`🎰 Betting panel already exists for game ${gameId} - skipping duplicate`);
                return false;
            }
            return true;
        } catch (error) {
            console.error('Error checking betting panel:', error);
            return true; // Default to creating panel if check fails
        }
    }

    // Enhanced prediction panel creation with team displays and stats
    async createEnhancedPredictionPanel(gameAnalysis) {
        try {
            const { trackedPlayer, teams, gameId, gameStartTime } = gameAnalysis;

            // Check if we should create this panel (prevent duplicates)
            if (!await this.shouldCreateBettingPanel(gameId)) {
                return null; // Skip panel creation
            }
            
            // Format tracked player's champion stats
            const champStats = trackedPlayer.championStats;
            const rankedStats = trackedPlayer.rankedStats;
            
            let trackedPlayerInfo;
            if (champStats.gamesPlayed === 0) {
                // First time playing this champion in ranked
                trackedPlayerInfo = 
                    `🏆 **${trackedPlayer.summoner.gameName}#${trackedPlayer.summoner.tagLine}** (${trackedPlayer.championName})\n` +
                    `🆕 **First game on ${trackedPlayer.championName}!** 🎯\n` +
                    `📈 **Overall Ranked:** ${rankedStats.winrate}% (${rankedStats.games}) | ${rankedStats.rank} ${rankedStats.lp} LP`;
            } else {
                // Has played this champion before
                trackedPlayerInfo = 
                    `🏆 **${trackedPlayer.summoner.gameName}#${trackedPlayer.summoner.tagLine}** (${trackedPlayer.championName})\n` +
                    `📊 Champion Stats (Last ${champStats.gamesPlayed} ${trackedPlayer.championName} games):\n` +
                    `   • **Winrate:** ${champStats.winrate}% (${champStats.recentForm}) • **Avg KDA:** ${champStats.avgKDA} • **Avg CS/min:** ${champStats.avgCS}\n` +
                    `📈 **Overall Ranked:** ${rankedStats.winrate}% (${rankedStats.games}) | ${rankedStats.rank} ${rankedStats.lp} LP`;
            }

            // Format team compositions with role indicators
            const getRoleEmoji = (role) => {
                const roleEmojis = {
                    'TOP': '🛡️',
                    'JUNGLE': '🌳', 
                    'MIDDLE': '⚡',
                    'BOTTOM': '🏹',
                    'UTILITY': '💚'
                };
                return roleEmojis[role] || '❓';
            };

            const formatPlayer = (player) => {
                const role = player.teamPosition || '';
                const roleEmoji = getRoleEmoji(role);
                const roleText = role ? `${roleEmoji} ` : '';
                
                if (player.isTracked) {
                    return `${roleText}**${player.summonerName}** • ${player.championName} • **${player.rankedStats.winrate}%** ⭐`;
                } else {
                    return `${roleText}${player.summonerName} • ${player.championName} • ${player.rankedStats.winrate}%`;
                }
            };

            const blueTeamDisplay = teams.blue.map(formatPlayer).join('\n');
            const redTeamDisplay = teams.red.map(formatPlayer).join('\n');

            // Get champion image for tracked player
            const championImageUrl = `https://ddragon.leagueoflegends.com/cdn/14.1.1/img/champion/${trackedPlayer.championName.replace(/[^a-zA-Z0-9]/g, '')}.png`;

            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle('🎯 LIVE RANKED GAME - PREDICTIONS OPEN 🎯')
                .setDescription(`${trackedPlayer.summoner.gameName}#${trackedPlayer.summoner.tagLine} vs Enemy Team | ⏱️ Predictions close <t:${Math.floor(Date.now() / 1000) + 240}:R>`)
                .setThumbnail(championImageUrl)
                .addFields(
                    {
                        name: '🏆 OUR PLAYER CHAMPION STATS',
                        value: trackedPlayerInfo,
                        inline: false
                    },
                    {
                        name: '🔵 BLUE TEAM',
                        value: blueTeamDisplay,
                        inline: true
                    },
                    {
                        name: '🔴 RED TEAM',
                        value: redTeamDisplay,
                        inline: true
                    },
                    {
                        name: '\u200B', // Empty field for spacing
                        value: '\u200B',
                        inline: false
                    },
                    {
                        name: '🎯 MAKE YOUR PREDICTION',
                        value: `Predict **${trackedPlayer.summoner.gameName}**'s game outcome to improve your accuracy!`,
                        inline: false
                    }
                )
                .setFooter({ text: 'LoL Paparazzi Predictions • Track your accuracy!' })
                .setTimestamp();

            const buttons = this.createPredictionButtons(gameId, false);

            return { 
                embeds: [embed], 
                components: buttons,
                gameAnalysis 
            };
        } catch (error) {
            console.error('Error creating enhanced betting panel:', error);
            
            // Fallback simple panel
            const embed = new EmbedBuilder()
                .setColor(0xff9900)
                .setTitle('🎯 LIVE RANKED GAME - PREDICTIONS OPEN 🎯')
                .setDescription('Loading game details...')
                .addFields({
                    name: '🎯 MAKE YOUR PREDICTION',
                    value: 'Predict the game outcome:',
                    inline: false
                })
                .setFooter({ text: 'LoL Paparazzi Predictions • Track your accuracy!' })
                .setTimestamp();

            const buttons = this.createPredictionButtons(gameAnalysis.gameId, false);
            return { embeds: [embed], components: buttons };
        }
    }


    formatPlayerForDisplay(player, isTracked = false) {
        const winrate = `${player.rankedStats.winrate}%`;
        const name = player.summonerName;
        const champion = player.championName;
        
        if (isTracked) {
            return `**${name}** (${champion}) **${winrate}** ⭐`;
        } else {
            return `${name} (${champion}) ${winrate}`;
        }
    }

    // Create stats modal content for enhanced display
    createStatsModalContent(gameAnalysis) {
        const { trackedPlayer, teams } = gameAnalysis;
        const champStats = trackedPlayer.championStats;
        
        let content = `**📊 DETAILED GAME ANALYSIS**\n\n`;
        content += `**🏆 ${trackedPlayer.summoner.gameName}#${trackedPlayer.summoner.tagLine}**\n`;
        content += `Champion: ${trackedPlayer.championName}\n`;
        content += `Champion Winrate: ${champStats.winrate}% (${champStats.gamesPlayed} games)\n`;
        content += `Avg KDA: ${champStats.avgKDA} | Avg CS/min: ${champStats.avgCS}\n`;
        content += `Recent Form: ${champStats.recentForm}\n\n`;
        
        content += `**⚔️ TEAM ANALYSIS**\n`;
        content += `🔵 **Blue Team Average WR:** ${this.calculateTeamWinrate(teams.blue)}%\n`;
        content += `🔴 **Red Team Average WR:** ${this.calculateTeamWinrate(teams.red)}%\n\n`;
        
        content += `**🎯 BETTING TIPS**\n`;
        if (champStats.winrate >= 70) {
            content += `• High champion winrate suggests comfort pick\n`;
        }
        if (champStats.avgKDA > 2.5) {
            content += `• Strong KDA average indicates good performance\n`;
        }
        
        return content;
    }

    calculateTeamWinrate(team) {
        const totalWinrate = team.reduce((sum, player) => sum + player.rankedStats.winrate, 0);
        return Math.round(totalWinrate / team.length);
    }

    // Get channel leaderboard for a specific tracked player
    async getChannelLeaderboard(channelId, trackedPlayerPuuid, limit = 10) {
        if (!this.persistence.databaseAvailable) {
            return [];
        }

        try {
            const result = await this.persistence.pool.query(`
                SELECT user_id, total_predictions, correct_predictions, accuracy_percentage, 
                       current_streak, best_streak, win_predictions, loss_predictions
                FROM user_prediction_accuracy 
                WHERE channel_id = $1 AND tracked_player_puuid = $2 AND total_predictions > 0
                ORDER BY accuracy_percentage DESC, total_predictions DESC
                LIMIT $3
            `, [channelId, trackedPlayerPuuid, limit]);

            return result.rows.map((row, index) => ({
                rank: index + 1,
                userId: row.user_id,
                totalPredictions: row.total_predictions,
                correctPredictions: row.correct_predictions,
                accuracy: parseFloat(row.accuracy_percentage),
                currentStreak: row.current_streak,
                bestStreak: row.best_streak,
                winPredictions: row.win_predictions,
                lossPredictions: row.loss_predictions
            }));
        } catch (error) {
            console.error('Error getting channel leaderboard:', error);
            return [];
        }
    }

    // Create accuracy display content for a user
    async createAccuracyDisplay(userId, guildId, channelId, trackedPlayerPuuid, trackedPlayerName) {
        try {
            const stats = await this.getUserPredictionStats(userId, guildId, channelId, trackedPlayerPuuid, trackedPlayerName);
            const history = await this.getUserPredictionHistory(userId, guildId, channelId, trackedPlayerPuuid, 5);

            let content = `**📊 YOUR PREDICTION ACCURACY**\n\n`;
            content += `**Player:** ${trackedPlayerName}\n`;
            content += `**Total Predictions:** ${stats.totalPredictions}\n`;
            content += `**Correct Predictions:** ${stats.correctPredictions}\n`;
            content += `**Accuracy:** ${stats.accuracy.toFixed(1)}%\n`;
            content += `**Current Streak:** ${stats.currentStreak}\n`;
            content += `**Best Streak:** ${stats.bestStreak}\n\n`;

            content += `**Prediction Breakdown:**\n`;
            content += `• WIN predictions: ${stats.winPredictions}\n`;
            content += `• LOSS predictions: ${stats.lossPredictions}\n\n`;

            if (history.length > 0) {
                content += `**Recent History:**\n`;
                history.forEach(h => {
                    const icon = h.wasCorrect ? '✅' : '❌';
                    content += `${icon} Predicted ${h.predictedOutcome.toUpperCase()}, was ${h.actualOutcome.toUpperCase()}\n`;
                });
            } else {
                content += `**No prediction history yet** - Make your first prediction!`;
            }

            return content;
        } catch (error) {
            console.error('Error creating accuracy display:', error);
            return '❌ Error loading your accuracy stats!';
        }
    }

    // Create leaderboard display content
    async createLeaderboardDisplay(channelId, trackedPlayerPuuid, trackedPlayerName) {
        try {
            const leaderboard = await this.getChannelLeaderboard(channelId, trackedPlayerPuuid, 10);

            if (leaderboard.length === 0) {
                return `**🏅 PREDICTION LEADERBOARD**\n\n**Player:** ${trackedPlayerName}\n\n*No predictions yet - be the first to predict!*`;
            }

            let content = `**🏅 PREDICTION LEADERBOARD**\n\n`;
            content += `**Player:** ${trackedPlayerName}\n\n`;

            leaderboard.forEach(entry => {
                const medal = entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : entry.rank === 3 ? '🥉' : `${entry.rank}.`;
                content += `${medal} <@${entry.userId}> - ${entry.accuracy.toFixed(1)}% (${entry.correctPredictions}/${entry.totalPredictions})\n`;
                content += `   • Streak: ${entry.currentStreak} | Best: ${entry.bestStreak}\n\n`;
            });

            return content;
        } catch (error) {
            console.error('Error creating leaderboard display:', error);
            return '❌ Error loading leaderboard!';
        }
    }

    // Format time remaining helper
    formatTimeRemaining(timeRemainingSeconds) {
        if (timeRemainingSeconds <= 0) return 0;
        
        const minutes = Math.floor(timeRemainingSeconds / 60);
        const seconds = timeRemainingSeconds % 60;
        
        if (minutes > 0) {
            return `${minutes}m ${seconds}s`;
        } else {
            return `${seconds}s`;
        }
    }
}

module.exports = BettingManager;