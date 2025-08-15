const { Client, GatewayIntentBits, Collection } = require('discord.js');
const cron = require('node-cron');
const { config, validateConfig } = require('./config');
const RiotAPI = require('./riotApi');
const PlayerTracker = require('./tracker');
const BettingManager = require('./bettingManager');
const createCommands = require('./commands');

validateConfig();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages
    ]
});

const riotApi = new RiotAPI(config.riot.apiKey);
const tracker = new PlayerTracker(riotApi, client);
const bettingManager = new BettingManager(tracker.persistence, riotApi);

// Make betting manager available to tracker
tracker.bettingManager = bettingManager;

// Global access for debugging/monitoring (use in Railway console)
global.showApiStats = () => riotApi.logDetailedStats();
global.riotApi = riotApi;

client.commands = new Collection();
const commands = createCommands(riotApi, tracker);

commands.forEach(command => {
    client.commands.set(command.data.name, command);
});

client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}!`);
    console.log('🎯 Use /setup <summoner> in a Discord channel to start tracking');
    
    try {
        console.log('🔄 Refreshing application (/) commands...');
        await client.application.commands.set(commands.map(cmd => cmd.data));
        console.log('✅ Successfully registered application commands.');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
    
    await tracker.startTracking();
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        // Handle slash commands
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error('Error executing command:', error);
            
            const errorMessage = {
                content: 'There was an error while executing this command!',
                ephemeral: true
            };
            
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errorMessage);
            } else {
                await interaction.reply(errorMessage);
            }
        }
    } else if (interaction.isButton()) {
        // Handle button interactions for betting
        await handleBettingButtons(interaction);
    }
});

async function handleBettingButtons(interaction) {
    try {
        const customId = interaction.customId;
        console.log(`🎰 Button interaction: ${customId}`);
        
        // Parse button custom ID: action_outcome_gameId or action_gameId
        const parts = customId.split('_');
        const action = parts[0];
        
        if (action === 'predict') {
            const outcome = parts[1]; // 'win' or 'loss'
            const gameId = parseInt(parts[2]); // Convert to number to match Riot API
            
            await handlePredictionPlacement(interaction, gameId, outcome);
        } else if (action === 'accuracy') {
            const gameId = parseInt(parts[1]);
            await handleAccuracyDisplay(interaction, gameId);
        } else if (action === 'leaderboard') {
            const gameId = parseInt(parts[1]);
            await handleLeaderboardDisplay(interaction, gameId);
        } else if (action === 'stats') {
            const gameId = parseInt(parts[1]);
            await handleStatsDisplay(interaction, gameId);
        }
    } catch (error) {
        console.error('Error handling prediction button:', error);
        
        // Provide more specific error messages based on the error type
        let errorContent = '❌ Unable to process prediction action!';
        
        if (error.message?.includes('game')) {
            errorContent = '🎮 Game is no longer available for predictions!';
        } else if (error.message?.includes('database') || error.message?.includes('pool')) {
            errorContent = '💾 Database temporarily unavailable. Please try again!';
        } else if (error.message?.includes('network') || error.message?.includes('fetch')) {
            errorContent = '🌐 Connection issue. Please try again in a moment!';
        } else if (error.message?.includes('timeout')) {
            errorContent = '⏰ Request timed out. Please try again!';
        }
        
        const errorMessage = {
            content: errorContent,
            ephemeral: true
        };
        
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(errorMessage);
        } else {
            await interaction.reply(errorMessage);
        }
    }
}

async function handlePredictionPlacement(interaction, gameId, outcome) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const channelId = interaction.channel.id;
    
    // Check if prediction window is still open
    const timeRemaining = bettingManager.getBettingTimeRemaining(gameId);
    if (timeRemaining <= 0) {
        return await interaction.reply({
            content: '🚫 Prediction window has closed for this game!',
            ephemeral: true
        });
    }
    
    // Get tracked player info for this game
    const playerSession = tracker.playerSession;
    if (!playerSession.currentGameId || playerSession.currentGameId !== gameId) {
        return await interaction.reply({
            content: '❌ This game is no longer active!',
            ephemeral: true
        });
    }
    
    // Get summoner info for prediction placement
    const summoner = await riotApi.getSummonerByName(playerSession.originalInput);
    const gameStartTime = new Date();
    const trackedPlayerName = `${summoner.gameName}#${summoner.tagLine}`;
    
    const result = await bettingManager.placePrediction(
        userId, guildId, gameId, summoner.puuid, 
        outcome, channelId, gameStartTime, trackedPlayerName
    );
    
    if (result.success) {
        await interaction.reply({
            content: `✅ ${result.message}`,
            ephemeral: true
        });
    } else {
        await interaction.reply({
            content: `❌ ${result.message}`,
            ephemeral: true
        });
    }
}

async function handleAccuracyDisplay(interaction, gameId) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const channelId = interaction.channel.id;
    
    try {
        // Get tracked player info for this game
        const playerSession = tracker.playerSession;
        if (!playerSession.currentGameId || playerSession.currentGameId !== gameId) {
            return await interaction.reply({
                content: '❌ This game is no longer active!',
                ephemeral: true
            });
        }
        
        // Get summoner info
        const summoner = await riotApi.getSummonerByName(playerSession.originalInput);
        const trackedPlayerName = `${summoner.gameName}#${summoner.tagLine}`;
        
        const response = await bettingManager.createAccuracyDisplay(
            userId, guildId, channelId, summoner.puuid, trackedPlayerName
        );
        
        await interaction.reply({
            content: response,
            ephemeral: true
        });
    } catch (error) {
        console.error('Error handling accuracy display:', error);
        await interaction.reply({
            content: '❌ Error loading your accuracy stats!',
            ephemeral: true
        });
    }
}

async function handleLeaderboardDisplay(interaction, gameId) {
    const channelId = interaction.channel.id;
    
    try {
        // Get tracked player info for this game
        const playerSession = tracker.playerSession;
        if (!playerSession.currentGameId || playerSession.currentGameId !== gameId) {
            return await interaction.reply({
                content: '❌ This game is no longer active!',
                ephemeral: true
            });
        }
        
        // Get summoner info
        const summoner = await riotApi.getSummonerByName(playerSession.originalInput);
        const trackedPlayerName = `${summoner.gameName}#${summoner.tagLine}`;
        
        const response = await bettingManager.createLeaderboardDisplay(
            channelId, summoner.puuid, trackedPlayerName
        );
        
        await interaction.reply({
            content: response,
            ephemeral: true
        });
    } catch (error) {
        console.error('Error handling leaderboard display:', error);
        await interaction.reply({
            content: '❌ Error loading leaderboard!',
            ephemeral: true
        });
    }
}

async function handleStatsDisplay(interaction, gameId) {
    try {
        // Get current game analysis if available
        const playerSession = tracker.playerSession;
        if (!playerSession.currentGameId || playerSession.currentGameId !== gameId) {
            return await interaction.reply({
                content: '❌ This game is no longer active!',
                ephemeral: true
            });
        }

        // Get summoner and current game data
        const summoner = await riotApi.getSummonerByName(playerSession.originalInput);
        const currentGame = await riotApi.getCurrentGame(summoner.puuid, true);
        
        if (!currentGame) {
            return await interaction.reply({
                content: '❌ No active game found!',
                ephemeral: true
            });
        }

        // Analyze current game for detailed stats
        const gameAnalysis = await riotApi.analyzeCurrentGame(summoner, currentGame);
        const statsContent = bettingManager.createStatsModalContent(gameAnalysis);
        
        // Check betting time remaining
        const timeRemaining = bettingManager.getBettingTimeRemaining(gameId);
        const timeText = bettingManager.formatTimeRemaining(timeRemaining);
        
        let response = `${statsContent}\n\n`;
        response += `⏰ **Prediction Window:** ${timeText > 0 ? `${timeText} remaining` : 'CLOSED'}\n`;
        
        // Show user's active predictions for this game
        const userId = interaction.user.id;
        const activePredictions = await bettingManager.getUserActivePredictions(userId, interaction.channel.id);
        const gamePredictions = activePredictions.filter(prediction => prediction.game_id === gameId);
        
        if (gamePredictions.length > 0) {
            response += `\n🎯 **Your Predictions:**\n`;
            gamePredictions.forEach(prediction => {
                response += `• Predicting ${prediction.predicted_outcome.toUpperCase()}\n`;
            });
        } else {
            response += `\n💡 **No predictions made** - Use the buttons above to predict!`;
        }
        
        await interaction.reply({
            content: response,
            ephemeral: true
        });
    } catch (error) {
        console.error('Error displaying game stats:', error);
        await interaction.reply({
            content: '❌ Error loading game statistics!',
            ephemeral: true
        });
    }
}

// Prediction system - no daily distributions needed for accuracy tracking

// Clean up old betting panels on startup and periodically
bettingManager.persistence.cleanupOldBettingPanels();
setInterval(() => {
    bettingManager.persistence.cleanupOldBettingPanels();
}, 30 * 60 * 1000); // Clean up every 30 minutes

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    tracker.stopTracking();
    client.destroy();
    process.exit(0);
});

client.login(config.discord.token);