const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

function createCommands(riotApi, tracker) {
    return [
        {
            data: new SlashCommandBuilder()
                .setName('setup')
                .setDescription('Set up tracking for a League of Legends player in this channel')
                .addStringOption(option =>
                    option.setName('summoner')
                        .setDescription('Your Riot ID in format: GameName#TAG (e.g., Melvinbung#NA1)')
                        .setRequired(true)),
            async execute(interaction) {
                const summonerName = interaction.options.getString('summoner');
                
                try {
                    const summoner = await riotApi.getSummonerByName(summonerName);
                    console.log('Summoner data:', summoner);
                    
                    if (!summoner) {
                        throw new Error('Failed to get summoner data');
                    }
                    
                    const displayName = `${summoner.gameName}#${summoner.tagLine}`;
                    await tracker.setPlayer(interaction.channelId, displayName, summonerName);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0x00ff00)
                        .setTitle('✅ Tracking Setup Complete!')
                        .setDescription(`Now tracking **${displayName}** daily performance in this channel!`)
                        .setTimestamp()
                        .setFooter({ text: 'LoL Paparazzi' });

                    await interaction.reply({ embeds: [embed] });
                } catch (error) {
                    console.error('Error in setup command:', error);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0xff0000)
                        .setTitle('❌ Error')
                        .setTimestamp()
                        .setFooter({ text: 'LoL Paparazzi' });
                    
                    if (error.message.startsWith('CHANNEL_OCCUPIED:')) {
                        const currentPlayer = error.message.split(':')[1];
                        embed.setDescription(`This channel is already tracking **${currentPlayer}**.\n\nUse \`/stop\` first to stop tracking the current player, then try \`/setup\` again with the new player.`);
                    } else {
                        embed.setDescription(`Could not find summoner "${summonerName}". Please check the spelling and try again.`);
                    }

                    await interaction.reply({ embeds: [embed] });
                }
            }
        },
        {
            data: new SlashCommandBuilder()
                .setName('stop')
                .setDescription('Stop tracking in this channel'),
            async execute(interaction) {
                const channelId = interaction.channelId;
                const playerData = tracker.getTrackerForChannel(channelId);
                const wasTracking = playerData !== undefined;
                const trackedSummoner = wasTracking ? playerData.summonerName : null;
                
                if (wasTracking) {
                    // Remove tracking for this channel
                    tracker.removeTracking(channelId);
                }
                
                const embed = new EmbedBuilder()
                    .setTimestamp()
                    .setFooter({ text: 'LoL Paparazzi' });

                if (wasTracking) {
                    embed.setColor(0xff9900)
                        .setTitle('🛑 Tracking Stopped')
                        .setDescription(`No longer tracking **${trackedSummoner}** in this channel.`);
                } else {
                    embed.setColor(0xff0000)
                        .setTitle('❌ No Active Tracking')
                        .setDescription('No players were being tracked in this channel.');
                }

                await interaction.reply({ embeds: [embed] });
            }
        },
        {
            data: new SlashCommandBuilder()
                .setName('info')
                .setDescription('Show current tracking information for this channel'),
            async execute(interaction) {
                const embed = new EmbedBuilder()
                    .setColor(0x0099ff)
                    .setTitle('📋 Tracking Info')
                    .setTimestamp()
                    .setFooter({ text: 'LoL Paparazzi' });

                const playerData = tracker.getTrackerForChannel(interaction.channelId);
                const dailyStats = tracker.dailyData.get(interaction.channelId);
                
                if (!playerData) {
                    embed.setDescription('No player is currently being tracked in this channel.\n\nUse `/setup <summoner>` to start tracking!');
                } else if (!dailyStats) {
                    embed.setDescription(`Tracking **${playerData.summonerName}** but no daily data available yet.`);
                } else {
                    const summoner = dailyStats.summoner;
                    embed.setDescription(`Tracking **${summoner.gameName}#${summoner.tagLine}**`);
                    
                    // Try to get current game status
                    try {
                        const currentGame = await riotApi.getCurrentGame(summoner.puuid);
                        const isInGame = currentGame && riotApi.isRankedSoloGame(currentGame);
                        
                        if (isInGame && currentGame.participants) {
                            const participant = currentGame.participants.find(p => p.puuid === summoner.puuid);
                            if (participant && participant.championId) {
                                const championName = await riotApi.getChampionNameById(participant.championId);
                                const championImageUrl = `https://ddragon.leagueoflegends.com/cdn/14.1.1/img/champion/${championName.replace(/[^a-zA-Z0-9]/g, '')}.png`;
                                embed.setThumbnail(championImageUrl);
                            }
                        }
                        
                        // Build fields
                        const fields = [];
                        
                        // Status field
                        if (isInGame) {
                            fields.push({
                                name: 'Status',
                                value: '🎮 Currently in ranked game',
                                inline: true
                            });
                        } else {
                            fields.push({
                                name: 'Status',
                                value: '💤 Not in game',
                                inline: true
                            });
                        }
                        
                        // Today's games
                        fields.push({
                            name: "Today's Games",
                            value: `${dailyStats.gamesPlayed} ranked${dailyStats.casualGames > 0 ? `, ${dailyStats.casualGames} casual` : ''}`,
                            inline: true
                        });
                        
                        // Daily stats if available
                        if (dailyStats.wins > 0 || dailyStats.losses > 0) {
                            const winrate = Math.round((dailyStats.wins / (dailyStats.wins + dailyStats.losses)) * 100);
                            fields.push({
                                name: "Today's Record",
                                value: `${dailyStats.wins}W-${dailyStats.losses}L (${winrate}% WR)`,
                                inline: true
                            });
                            
                            // LP change today
                            if (dailyStats.totalLPChange !== 0) {
                                const lpEmoji = dailyStats.totalLPChange > 0 ? '📈' : '📉';
                                fields.push({
                                    name: "Today's LP",
                                    value: `${lpEmoji} ${dailyStats.totalLPChange > 0 ? '+' : ''}${dailyStats.totalLPChange} LP`,
                                    inline: true
                                });
                            }
                        }
                        
                        embed.addFields(...fields);
                    } catch (error) {
                        console.error('Error fetching game status:', error);
                        embed.addFields({ name: 'Status', value: '⚠️ Error fetching status', inline: true });
                    }
                }

                await interaction.reply({ embeds: [embed] });
            }
        },
        {
            data: new SlashCommandBuilder()
                .setName('join')
                .setDescription('Get the Paparazzi role to be notified when gaming sessions start'),
            async execute(interaction) {
                try {
                    const guild = interaction.guild;
                    const member = interaction.member;
                    
                    if (!guild || !member) {
                        throw new Error('This command can only be used in a server.');
                    }
                    
                    // Find or create the Paparazzi role
                    let paparazziRole = guild.roles.cache.find(role => role.name === 'Paparazzi');
                    
                    if (!paparazziRole) {
                        paparazziRole = await guild.roles.create({
                            name: 'Paparazzi',
                            color: 0x00ff00,
                            reason: 'LoL Paparazzi notification role',
                            mentionable: true
                        });
                        console.log('Created Paparazzi role');
                    }
                    
                    // Check if user already has the role
                    if (member.roles.cache.has(paparazziRole.id)) {
                        const embed = new EmbedBuilder()
                            .setColor(0xff9900)
                            .setTitle('📸 Already a Paparazzi!')
                            .setDescription('You already have the Paparazzi role and will be notified when gaming sessions start.')
                            .setTimestamp()
                            .setFooter({ text: 'LoL Paparazzi' });

                        await interaction.reply({ embeds: [embed] });
                        return;
                    }
                    
                    // Add the role to the user
                    await member.roles.add(paparazziRole);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0x00ff00)
                        .setTitle('📸 Welcome to the Paparazzi!')
                        .setDescription('You now have the Paparazzi role and will be notified when gaming sessions start.\n\nUse `/leave` if you want to stop receiving notifications.')
                        .setTimestamp()
                        .setFooter({ text: 'LoL Paparazzi' });

                    await interaction.reply({ embeds: [embed] });
                } catch (error) {
                    console.error('Error in join command:', error);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0xff0000)
                        .setTitle('❌ Error')
                        .setDescription('Could not add the Paparazzi role. Make sure the bot has permission to manage roles.')
                        .setTimestamp()
                        .setFooter({ text: 'LoL Paparazzi' });

                    await interaction.reply({ embeds: [embed] });
                }
            }
        },
        {
            data: new SlashCommandBuilder()
                .setName('leave')
                .setDescription('Remove the Paparazzi role to stop receiving session notifications'),
            async execute(interaction) {
                try {
                    const guild = interaction.guild;
                    const member = interaction.member;
                    
                    if (!guild || !member) {
                        throw new Error('This command can only be used in a server.');
                    }
                    
                    // Find the Paparazzi role
                    const paparazziRole = guild.roles.cache.find(role => role.name === 'Paparazzi');
                    
                    if (!paparazziRole) {
                        const embed = new EmbedBuilder()
                            .setColor(0xff9900)
                            .setTitle('📸 No Paparazzi Role Found')
                            .setDescription('There is no Paparazzi role in this server. Use `/join` to create one and join!')
                            .setTimestamp()
                            .setFooter({ text: 'LoL Paparazzi' });

                        await interaction.reply({ embeds: [embed] });
                        return;
                    }
                    
                    // Check if user has the role
                    if (!member.roles.cache.has(paparazziRole.id)) {
                        const embed = new EmbedBuilder()
                            .setColor(0xff9900)
                            .setTitle('📸 Not a Paparazzi')
                            .setDescription('You don\'t have the Paparazzi role. Use `/join` to get notifications!')
                            .setTimestamp()
                            .setFooter({ text: 'LoL Paparazzi' });

                        await interaction.reply({ embeds: [embed] });
                        return;
                    }
                    
                    // Remove the role from the user
                    await member.roles.remove(paparazziRole);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0xff9900)
                        .setTitle('📸 Left the Paparazzi')
                        .setDescription('You have removed the Paparazzi role and will no longer receive gaming session notifications.\n\nUse `/join` if you want to start receiving notifications again.')
                        .setTimestamp()
                        .setFooter({ text: 'LoL Paparazzi' });

                    await interaction.reply({ embeds: [embed] });
                } catch (error) {
                    console.error('Error in leave command:', error);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0xff0000)
                        .setTitle('❌ Error')
                        .setDescription('Could not remove the Paparazzi role. Make sure the bot has permission to manage roles.')
                        .setTimestamp()
                        .setFooter({ text: 'LoL Paparazzi' });

                    await interaction.reply({ embeds: [embed] });
                }
            }
        },
        {
            data: new SlashCommandBuilder()
                .setName('balance')
                .setDescription('Check your betting credits and statistics'),
            async execute(interaction) {
                // This functionality is also available via the betting panel buttons
                // but providing a slash command for convenience
                try {
                    const userId = interaction.user.id;
                    const guildId = interaction.guild.id;
                    
                    // Access betting manager through tracker (since it's not directly passed to commands)
                    const bettingManager = tracker.bettingManager;
                    if (!bettingManager) {
                        return await interaction.reply({
                            content: '❌ Betting system is not available!',
                            ephemeral: true
                        });
                    }
                    
                    const credits = await bettingManager.getUserCredits(userId, guildId);
                    const activeBets = await bettingManager.getUserActiveBets(userId);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0x0099ff)
                        .setTitle('💰 Your Betting Balance')
                        .addFields(
                            {
                                name: '💎 Current Balance',
                                value: `${credits.balance}💎`,
                                inline: true
                            },
                            {
                                name: '📊 Total Winnings',
                                value: `${credits.totalWinnings || 0}💎`,
                                inline: true
                            },
                            {
                                name: '📉 Total Losses',
                                value: `${credits.totalLosses || 0}💎`,
                                inline: true
                            }
                        )
                        .setTimestamp()
                        .setFooter({ text: 'LoL Paparazzi Betting' });
                    
                    if (activeBets.length > 0) {
                        const betsList = activeBets.map(bet => 
                            `• ${bet.bet_amount}💎 on ${bet.bet_outcome.toUpperCase()}`
                        ).join('\n');
                        
                        embed.addFields({
                            name: `🎯 Active Bets (${activeBets.length})`,
                            value: betsList,
                            inline: false
                        });
                    }
                    
                    if (credits.canClaimDaily) {
                        embed.addFields({
                            name: '🎁 Daily Bonus',
                            value: 'You can claim 100💎 daily bonus! Use betting panel buttons.',
                            inline: false
                        });
                    }
                    
                    await interaction.reply({ embeds: [embed], ephemeral: true });
                } catch (error) {
                    console.error('Error in balance command:', error);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0xff0000)
                        .setTitle('❌ Error')
                        .setDescription('Could not retrieve your balance information.')
                        .setTimestamp()
                        .setFooter({ text: 'LoL Paparazzi' });

                    await interaction.reply({ embeds: [embed], ephemeral: true });
                }
            }
        }
    ];
}

module.exports = createCommands;