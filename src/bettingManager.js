const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

class BettingManager {
    constructor(persistence, riotApi) {
        this.persistence = persistence;
        this.riotApi = riotApi;
        this.activeBettingPanels = new Map(); // gameId -> panel info
        this.bettingTimeouts = new Map(); // gameId -> timeout
    }

    // User credit management
    async getUserCredits(userId, guildId) {
        if (!this.persistence.databaseAvailable) {
            return { balance: 100, canClaimDaily: false };
        }

        try {
            const result = await this.persistence.pool.query(`
                SELECT * FROM user_credits WHERE user_id = $1 AND guild_id = $2
            `, [userId, guildId]);

            if (result.rows.length === 0) {
                // Create new user with starting balance
                await this.persistence.pool.query(`
                    INSERT INTO user_credits (user_id, guild_id, balance)
                    VALUES ($1, $2, 100)
                `, [userId, guildId]);
                
                return { balance: 100, canClaimDaily: true, isNewUser: true };
            }

            const userData = result.rows[0];
            const today = new Date().toISOString().split('T')[0];
            const canClaimDaily = !userData.last_daily_claim || userData.last_daily_claim !== today;

            return {
                balance: userData.balance,
                totalWinnings: userData.total_winnings,
                totalLosses: userData.total_losses,
                canClaimDaily,
                lastClaim: userData.last_daily_claim
            };
        } catch (error) {
            console.error('Error getting user credits:', error);
            return { balance: 100, canClaimDaily: false, error: true };
        }
    }

    async claimDailyCredits(userId, guildId) {
        if (!this.persistence.databaseAvailable) {
            return { success: false, message: 'Database not available' };
        }

        try {
            const today = new Date().toISOString().split('T')[0];
            
            const result = await this.persistence.pool.query(`
                UPDATE user_credits 
                SET balance = balance + 100, 
                    last_daily_claim = $3,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $1 AND guild_id = $2 
                AND (last_daily_claim IS NULL OR last_daily_claim != $3)
                RETURNING balance
            `, [userId, guildId, today]);

            if (result.rows.length === 0) {
                return { success: false, message: 'Already claimed today or user not found' };
            }

            return { 
                success: true, 
                newBalance: result.rows[0].balance,
                message: '+100💎 claimed!' 
            };
        } catch (error) {
            console.error('Error claiming daily credits:', error);
            return { success: false, message: 'Database error' };
        }
    }

    async placeBet(userId, guildId, gameId, playerPuuid, betAmount, betOutcome, channelId, gameStartTime) {
        if (!this.persistence.databaseAvailable) {
            return { success: false, message: 'Database not available' };
        }

        try {
            await this.persistence.pool.query('BEGIN');

            // Check user balance
            const userCredits = await this.getUserCredits(userId, guildId);
            if (userCredits.balance < betAmount) {
                await this.persistence.pool.query('ROLLBACK');
                return { success: false, message: `Insufficient credits! You have ${userCredits.balance}💎` };
            }

            // Check if user already has a bet on this game
            const existingBet = await this.persistence.pool.query(`
                SELECT id FROM active_bets 
                WHERE user_id = $1 AND game_id = $2 AND status = 'active'
            `, [userId, gameId]);

            if (existingBet.rows.length > 0) {
                await this.persistence.pool.query('ROLLBACK');
                return { success: false, message: 'You already have a bet on this game!' };
            }

            // Deduct credits and place bet
            await this.persistence.pool.query(`
                UPDATE user_credits 
                SET balance = balance - $3, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $1 AND guild_id = $2
            `, [userId, guildId, betAmount]);

            await this.persistence.pool.query(`
                INSERT INTO active_bets (
                    user_id, guild_id, game_id, player_puuid, bet_amount, 
                    bet_outcome, channel_id, game_start_time
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [userId, guildId, gameId, playerPuuid, betAmount, betOutcome, channelId, gameStartTime]);

            await this.persistence.pool.query('COMMIT');

            return { 
                success: true, 
                message: `Bet placed! ${betAmount}💎 on ${betOutcome.toUpperCase()}`,
                newBalance: userCredits.balance - betAmount
            };
        } catch (error) {
            await this.persistence.pool.query('ROLLBACK');
            console.error('Error placing bet:', error);
            return { success: false, message: 'Failed to place bet' };
        }
    }

    async resolveBets(gameId, actualOutcome, matchId = null) {
        if (!this.persistence.databaseAvailable) {
            console.log('⚠️ Cannot resolve bets - database not available');
            return [];
        }

        try {
            console.log(`🎰 Resolving bets for game ${gameId}, outcome: ${actualOutcome}`);
            
            await this.persistence.pool.query('BEGIN');

            // Get all active bets for this game
            const activeBets = await this.persistence.pool.query(`
                SELECT * FROM active_bets 
                WHERE game_id = $1 AND status = 'active'
            `, [gameId]);

            const results = [];

            for (const bet of activeBets.rows) {
                const won = bet.bet_outcome === actualOutcome;
                const payout = won ? bet.bet_amount * 2 : 0;
                const resultStatus = won ? 'won' : 'lost';

                // Update user balance if they won
                if (won) {
                    await this.persistence.pool.query(`
                        UPDATE user_credits 
                        SET balance = balance + $2,
                            total_winnings = total_winnings + $3,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE user_id = $1
                    `, [bet.user_id, payout, bet.bet_amount]);
                } else {
                    await this.persistence.pool.query(`
                        UPDATE user_credits 
                        SET total_losses = total_losses + $2,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE user_id = $1
                    `, [bet.user_id, bet.bet_amount]);
                }

                // Mark bet as resolved
                await this.persistence.pool.query(`
                    UPDATE active_bets 
                    SET status = $2, resolved_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [bet.id, resultStatus]);

                // Add to bet history
                await this.persistence.pool.query(`
                    INSERT INTO bet_history (
                        user_id, guild_id, bet_amount, bet_outcome, 
                        actual_outcome, result, payout_amount, match_id
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `, [
                    bet.user_id, bet.guild_id, bet.bet_amount, bet.bet_outcome,
                    actualOutcome, resultStatus, payout, matchId
                ]);

                results.push({
                    userId: bet.user_id,
                    betAmount: bet.bet_amount,
                    betOutcome: bet.bet_outcome,
                    won,
                    payout,
                    channelId: bet.channel_id
                });
            }

            await this.persistence.pool.query('COMMIT');
            console.log(`✅ Resolved ${results.length} bets for game ${gameId}`);
            
            return results;
        } catch (error) {
            await this.persistence.pool.query('ROLLBACK');
            console.error('Error resolving bets:', error);
            return [];
        }
    }

    async expireBets(gameId) {
        if (!this.persistence.databaseAvailable) {
            return [];
        }

        try {
            // Get active bets and refund them
            const activeBets = await this.persistence.pool.query(`
                SELECT * FROM active_bets 
                WHERE game_id = $1 AND status = 'active'
            `, [gameId]);

            await this.persistence.pool.query('BEGIN');

            const refunds = [];
            for (const bet of activeBets.rows) {
                // Refund the bet amount
                await this.persistence.pool.query(`
                    UPDATE user_credits 
                    SET balance = balance + $2, updated_at = CURRENT_TIMESTAMP
                    WHERE user_id = $1
                `, [bet.user_id, bet.bet_amount]);

                // Mark bet as expired
                await this.persistence.pool.query(`
                    UPDATE active_bets 
                    SET status = 'expired', resolved_at = CURRENT_TIMESTAMP
                    WHERE id = $1
                `, [bet.id]);

                refunds.push({
                    userId: bet.user_id,
                    betAmount: bet.bet_amount,
                    channelId: bet.channel_id
                });
            }

            await this.persistence.pool.query('COMMIT');
            console.log(`🔄 Expired and refunded ${refunds.length} bets for game ${gameId}`);
            
            return refunds;
        } catch (error) {
            await this.persistence.pool.query('ROLLBACK');
            console.error('Error expiring bets:', error);
            return [];
        }
    }

    async getUserActiveBets(userId) {
        if (!this.persistence.databaseAvailable) {
            return [];
        }

        try {
            const result = await this.persistence.pool.query(`
                SELECT * FROM active_bets 
                WHERE user_id = $1 AND status = 'active'
                ORDER BY created_at DESC
            `, [userId]);

            return result.rows;
        } catch (error) {
            console.error('Error getting user active bets:', error);
            return [];
        }
    }

    createBettingButtons(gameId, disabled = false) {
        const winButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`bet_win_30_${gameId}`)
                .setLabel('WIN - 30💎')
                .setStyle(ButtonStyle.Success)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`bet_win_50_${gameId}`)
                .setLabel('WIN - 50💎')
                .setStyle(ButtonStyle.Success)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`bet_win_100_${gameId}`)
                .setLabel('WIN - 100💎')
                .setStyle(ButtonStyle.Success)
                .setDisabled(disabled)
        );

        const lossButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`bet_loss_30_${gameId}`)
                .setLabel('LOSS - 30💎')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`bet_loss_50_${gameId}`)
                .setLabel('LOSS - 50💎')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`bet_loss_100_${gameId}`)
                .setLabel('LOSS - 100💎')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(disabled)
        );

        const utilityButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`balance_${gameId}`)
                .setLabel('💰 Balance')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`daily_${gameId}`)
                .setLabel('📊 Daily: +100💎')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`stats_${gameId}`)
                .setLabel('📈 Stats')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disabled)
        );

        return [winButtons, lossButtons, utilityButtons];
    }

    // Store betting panel info for later updates
    setBettingPanel(gameId, messageId, channelId, startTime) {
        this.activeBettingPanels.set(gameId, {
            messageId,
            channelId,
            startTime,
            betsCount: 0
        });

        // Set 4-minute timeout to close betting
        const timeout = setTimeout(async () => {
            await this.closeBettingWindow(gameId);
        }, 4 * 60 * 1000);

        this.bettingTimeouts.set(gameId, timeout);
    }

    async closeBettingWindow(gameId) {
        const panelInfo = this.activeBettingPanels.get(gameId);
        if (!panelInfo) return;

        console.log(`🚫 Closing betting window for game ${gameId}`);
        
        // Clear timeout if it exists
        const timeout = this.bettingTimeouts.get(gameId);
        if (timeout) {
            clearTimeout(timeout);
            this.bettingTimeouts.delete(gameId);
        }

        // Remove from active panels
        this.activeBettingPanels.delete(gameId);
    }


    // Enhanced betting panel creation with team displays and stats
    async createEnhancedBettingPanel(gameAnalysis) {
        try {
            const { trackedPlayer, teams, gameId, gameStartTime } = gameAnalysis;
            
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

            // Format team compositions
            const blueTeamDisplay = teams.blue.map(player => {
                if (player.isTracked) {
                    return `**${player.summonerName}** • ${player.championName} • **${player.rankedStats.winrate}%** ⭐`;
                } else {
                    return `${player.summonerName} • ${player.championName} • ${player.rankedStats.winrate}%`;
                }
            }).join('\n');

            const redTeamDisplay = teams.red.map(player => {
                if (player.isTracked) {
                    return `**${player.summonerName}** • ${player.championName} • **${player.rankedStats.winrate}%** ⭐`;
                } else {
                    return `${player.summonerName} • ${player.championName} • ${player.rankedStats.winrate}%`;
                }
            }).join('\n');

            // Get champion image for tracked player
            const championImageUrl = `https://ddragon.leagueoflegends.com/cdn/14.1.1/img/champion/${trackedPlayer.championName.replace(/[^a-zA-Z0-9]/g, '')}.png`;

            const embed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle('🎮 LIVE RANKED GAME - BETTING OPEN 🎮')
                .setDescription(`${trackedPlayer.summoner.gameName}#${trackedPlayer.summoner.tagLine} vs Enemy Team | ⏱️ Betting closes <t:${Math.floor(Date.now() / 1000) + 240}:R>`)
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
                        name: '🎯 PLACE YOUR BET',
                        value: `Bet on **${trackedPlayer.summoner.gameName}**'s game outcome:`,
                        inline: false
                    }
                )
                .setFooter({ text: 'LoL Paparazzi Betting • Double or nothing!' })
                .setTimestamp();

            const buttons = this.createBettingButtons(gameId, false);

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
                .setTitle('🎮 LIVE RANKED GAME - BETTING OPEN 🎮')
                .setDescription('Loading game details...')
                .addFields({
                    name: '🎯 PLACE YOUR BET',
                    value: 'Bet on the game outcome:',
                    inline: false
                })
                .setFooter({ text: 'LoL Paparazzi Betting • Double or nothing!' })
                .setTimestamp();

            const buttons = this.createBettingButtons(gameAnalysis.gameId, false);
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
}

module.exports = BettingManager;