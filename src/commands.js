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
                    
                    // Try to get rank info, but don't fail if summoner.id is missing
                    const rankInfo = await riotApi.getRankInfo(summoner.id);
                    const formattedRank = riotApi.formatRankInfo(rankInfo);
                    
                    const displayName = summoner.gameName ? `${summoner.gameName}#${summoner.tagLine}` : summoner.name;
                    tracker.setPlayer(interaction.channelId, displayName, summonerName);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0x00ff00)
                        .setTitle('✅ Tracking Setup Complete!')
                        .setDescription(`Now tracking **${displayName}** for ranked solo queue sessions in this channel!`)
                        .addFields(
                            { name: 'Current Rank', value: formattedRank, inline: true },
                            { name: 'Level', value: summoner.summonerLevel.toString(), inline: true },
                            { name: 'Session Timeout', value: '15 minutes', inline: true }
                        )
                        .setTimestamp()
                        .setFooter({ text: 'LoL Paparazzi' });

                    await interaction.reply({ embeds: [embed] });
                } catch (error) {
                    console.error('Error in setup command:', error);
                    
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
                .setName('stop')
                .setDescription('Stop tracking in this channel'),
            async execute(interaction) {
                const wasTracking = tracker.playerSession.channelId === interaction.channelId;
                
                if (wasTracking) {
                    tracker.resetSession();
                    tracker.playerSession.channelId = null;
                    tracker.playerSession.summonerName = null;
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
                    const statusEmoji = tracker.playerSession.inSession ? '🎮' : '⏸️';
                    const statusText = tracker.playerSession.inSession ? 'In Gaming Session' : 'Not Playing';
                    
                    embed.setDescription(`Tracking **${tracker.playerSession.summonerName}**`)
                        .addFields(
                            { name: 'Status', value: `${statusEmoji} ${statusText}`, inline: true },
                            { name: 'Session Games', value: tracker.playerSession.gameCount.toString(), inline: true }
                        );
                    
                    if (tracker.playerSession.inSession && tracker.playerSession.sessionStartTime) {
                        const duration = Math.floor((new Date() - tracker.playerSession.sessionStartTime) / 1000 / 60);
                        embed.addFields({ name: 'Session Duration', value: `${duration} minutes`, inline: true });
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
                    const currentGame = await riotApi.getCurrentGame(summoner.id);
                    const rankInfo = await riotApi.getRankInfo(summoner.id);
                    const formattedRank = riotApi.formatRankInfo(rankInfo);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0x0099ff)
                        .setTitle(`📊 ${summoner.name}'s Status`)
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
        }
    ];
}

module.exports = createCommands;