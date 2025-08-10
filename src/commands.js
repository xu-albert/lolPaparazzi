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
                        .setDescription(`Now tracking **${displayName}** for ranked solo queue sessions in this channel!`)
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
                const wasTracking = tracker.playerSession.channelId === interaction.channelId;
                
                if (wasTracking) {
                    tracker.resetSession();
                    tracker.playerSession.channelId = null;
                    tracker.playerSession.summonerName = null;
                    tracker.playerSession.originalInput = null;
                    // Clear saved data for this channel only
                    tracker.persistence.clearTrackingData(interaction.channelId);
                }
                
                const embed = new EmbedBuilder()
                    .setTimestamp()
                    .setFooter({ text: 'LoL Paparazzi' });

                if (wasTracking) {
                    embed.setColor(0xff9900)
                        .setTitle('🛑 Tracking Stopped')
                        .setDescription('No longer tracking players in this channel.');
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

                if (!tracker.playerSession.summonerName || tracker.playerSession.channelId !== interaction.channelId) {
                    embed.setDescription('No player is currently being tracked in this channel.\n\nUse `/setup <summoner>` to start tracking!');
                } else {
                    // Get real-time session metrics with rate limiting
                    const metrics = await tracker.getRealTimeSessionMetrics(interaction.user.id);
                    
                    if (metrics.error) {
                        embed.setDescription(`Tracking **${tracker.playerSession.summonerName}**\n\n⚠️ ${metrics.error}`)
                            .setColor(0xff9900);
                    } else {
                        embed.setDescription(`Tracking **${tracker.playerSession.summonerName}**`);
                        
                        // Add champion thumbnail if player is in game
                        if (metrics.isInGame && metrics.currentChampion) {
                            // Use champion square image as thumbnail
                            const championImageUrl = `https://ddragon.leagueoflegends.com/cdn/14.1.1/img/champion/${metrics.currentChampion.replace(/[^a-zA-Z0-9]/g, '')}.png`;
                            embed.setThumbnail(championImageUrl);
                        }
                        
                        // Status and games
                        const fields = [
                            { 
                                name: 'Status', 
                                value: `${metrics.statusEmoji} ${metrics.status}`, 
                                inline: true 
                            }
                        ];
                        
                        // Show game counts if in session
                        if (tracker.playerSession.inSession) {
                            fields.push({
                                name: 'Session Games',
                                value: `${metrics.completedGames} completed${metrics.isInGame ? ' + 1 current' : ''}`,
                                inline: true
                            });
                            
                            // Session duration
                            if (metrics.durationText !== 'No session active') {
                                fields.push({
                                    name: 'Session Duration',
                                    value: metrics.durationText,
                                    inline: true
                                });
                            }
                        }
                        
                        // Add session stats if available
                        if (metrics.sessionStats && (metrics.sessionStats.wins > 0 || metrics.sessionStats.losses > 0)) {
                            const winrate = Math.round((metrics.sessionStats.wins / (metrics.sessionStats.wins + metrics.sessionStats.losses)) * 100);
                            fields.push({
                                name: 'Session Record',
                                value: `${metrics.sessionStats.wins}W-${metrics.sessionStats.losses}L (${winrate}% WR)`,
                                inline: true
                            });
                        }
                        
                        
                        embed.addFields(...fields);
                    }
                }

                await interaction.reply({ embeds: [embed] });
            }
        },
        {
            data: new SlashCommandBuilder()
                .setName('status')
                .setDescription('Check current status of a League of Legends player')
                .addStringOption(option =>
                    option.setName('summoner')
                        .setDescription('The summoner name to check')
                        .setRequired(true)),
            async execute(interaction) {
                const summonerName = interaction.options.getString('summoner');
                
                try {
                    const summoner = await riotApi.getSummonerByName(summonerName);
                    const currentGame = await riotApi.getCurrentGame(summoner.puuid);
                    const rankInfo = await riotApi.getRankInfo(summoner.puuid);
                    const formattedRank = riotApi.formatRankInfo(rankInfo);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0x0099ff)
                        .setTitle(`📊 ${summoner.gameName}#${summoner.tagLine}'s Status`)
                        .addFields(
                            { name: 'Rank', value: formattedRank, inline: true },
                            { name: 'Level', value: summoner.summonerLevel.toString(), inline: true }
                        )
                        .setTimestamp()
                        .setFooter({ text: 'LoL Paparazzi' });

                    if (currentGame) {
                        if (riotApi.isRankedSoloGame(currentGame)) {
                            embed.addFields({ name: 'Status', value: '🎮 Playing Ranked Solo Queue', inline: false });
                            embed.setColor(0x00ff00);
                        } else {
                            embed.addFields({ name: 'Status', value: '🎮 Playing Other Game Mode', inline: false });
                            embed.setColor(0xff9900);
                        }
                    } else {
                        embed.addFields({ name: 'Status', value: '⏸️ Not Currently Playing', inline: false });
                    }

                    await interaction.reply({ embeds: [embed] });
                } catch (error) {
                    console.error('Error in status command:', error);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0xff0000)
                        .setTitle('❌ Error')
                        .setDescription(`Could not find summoner "${summonerName}". Please check the spelling and try again.`)
                        .setTimestamp()
                        .setFooter({ text: 'LoL Paparazzi' });

                    await interaction.reply({ embeds: [embed] });
                }
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
        }
    ];
}

module.exports = createCommands;