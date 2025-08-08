const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

function createCommands(riotApi, tracker) {
    return [
        {
            data: new SlashCommandBuilder()
                .setName('track')
                .setDescription('Start tracking a League of Legends player')
                .addStringOption(option =>
                    option.setName('summoner')
                        .setDescription('The summoner name to track')
                        .setRequired(true)),
            async execute(interaction) {
                const summonerName = interaction.options.getString('summoner');
                
                try {
                    const summoner = await riotApi.getSummonerByName(summonerName);
                    const rankInfo = await riotApi.getRankInfo(summoner.id);
                    const formattedRank = riotApi.formatRankInfo(rankInfo);
                    
                    tracker.addPlayer(interaction.channelId, summoner.name, interaction.user.id);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0x00ff00)
                        .setTitle('✅ Player Added to Tracking')
                        .setDescription(`Now tracking **${summoner.name}** for ranked solo queue games!`)
                        .addFields(
                            { name: 'Current Rank', value: formattedRank, inline: true },
                            { name: 'Level', value: summoner.summonerLevel.toString(), inline: true }
                        )
                        .setTimestamp()
                        .setFooter({ text: 'LoL Paparazzi' });

                    await interaction.reply({ embeds: [embed] });
                } catch (error) {
                    console.error('Error in track command:', error);
                    
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
                .setName('untrack')
                .setDescription('Stop tracking a League of Legends player')
                .addStringOption(option =>
                    option.setName('summoner')
                        .setDescription('The summoner name to stop tracking')
                        .setRequired(true)),
            async execute(interaction) {
                const summonerName = interaction.options.getString('summoner');
                const removed = tracker.removePlayer(interaction.channelId, summonerName);
                
                const embed = new EmbedBuilder()
                    .setTimestamp()
                    .setFooter({ text: 'LoL Paparazzi' });

                if (removed) {
                    embed.setColor(0xff9900)
                        .setTitle('🗑️ Player Removed')
                        .setDescription(`Stopped tracking **${summonerName}**.`);
                } else {
                    embed.setColor(0xff0000)
                        .setTitle('❌ Player Not Found')
                        .setDescription(`**${summonerName}** was not being tracked in this channel.`);
                }

                await interaction.reply({ embeds: [embed] });
            }
        },
        {
            data: new SlashCommandBuilder()
                .setName('list')
                .setDescription('List all tracked players in this channel'),
            async execute(interaction) {
                const trackedPlayers = tracker.getTrackedPlayers(interaction.channelId);
                
                const embed = new EmbedBuilder()
                    .setColor(0x0099ff)
                    .setTitle('📋 Tracked Players')
                    .setTimestamp()
                    .setFooter({ text: 'LoL Paparazzi' });

                if (trackedPlayers.length === 0) {
                    embed.setDescription('No players are currently being tracked in this channel.\n\nUse `/track <summoner>` to start tracking someone!');
                } else {
                    const playerList = trackedPlayers
                        .map((player, index) => `${index + 1}. **${player.summonerName}** ${player.currentlyInGame ? '🎮 (In Game)' : '⏸️ (Not Playing)'}`)
                        .join('\n');
                    
                    embed.setDescription(playerList);
                    embed.addFields({ name: 'Total', value: `${trackedPlayers.length} player(s)`, inline: true });
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