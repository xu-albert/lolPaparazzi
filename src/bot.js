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
        
        // Parse button custom ID: action_outcome_amount_gameId or action_gameId
        const parts = customId.split('_');
        const action = parts[0];
        
        if (action === 'bet') {
            const outcome = parts[1]; // 'win' or 'loss'
            const amount = parseInt(parts[2]); // 30, 50, or 100
            const gameId = parts[3];
            
            await handleBetPlacement(interaction, gameId, outcome, amount);
        } else if (action === 'balance') {
            const gameId = parts[1];
            await handleBalanceCheck(interaction);
        } else if (action === 'daily') {
            const gameId = parts[1];
            await handleDailyCredits(interaction);
        } else if (action === 'stats') {
            const gameId = parts[1];
            await handleStatsDisplay(interaction, gameId);
        }
    } catch (error) {
        console.error('Error handling betting button:', error);
        
        const errorMessage = {
            content: 'There was an error processing your bet!',
            ephemeral: true
        };
        
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(errorMessage);
        } else {
            await interaction.reply(errorMessage);
        }
    }
}

async function handleBetPlacement(interaction, gameId, outcome, amount) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    const channelId = interaction.channel.id;
    
    // Check if betting window is still open
    const timeRemaining = bettingManager.getBettingTimeRemaining(gameId);
    if (timeRemaining <= 0) {
        return await interaction.reply({
            content: '🚫 Betting window has closed for this game!',
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
    
    // Get summoner info for bet placement
    const summoner = await riotApi.getSummonerByName(playerSession.originalInput);
    const gameStartTime = new Date();
    
    const result = await bettingManager.placeBet(
        userId, guildId, gameId, summoner.puuid, 
        amount, outcome, channelId, gameStartTime
    );
    
    if (result.success) {
        await interaction.reply({
            content: `✅ ${result.message}\nRemaining balance: ${result.newBalance}💎`,
            ephemeral: true
        });
    } else {
        await interaction.reply({
            content: `❌ ${result.message}`,
            ephemeral: true
        });
    }
}

async function handleBalanceCheck(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    
    const credits = await bettingManager.getUserCredits(userId, guildId);
    const activeBets = await bettingManager.getUserActiveBets(userId);
    
    let response = `💰 **Your Balance:** ${credits.balance}💎\n`;
    response += `📊 **Total Winnings:** ${credits.totalWinnings || 0}💎\n`;
    response += `📉 **Total Losses:** ${credits.totalLosses || 0}💎\n`;
    
    if (activeBets.length > 0) {
        response += `\n🎯 **Active Bets:** ${activeBets.length}\n`;
        activeBets.forEach(bet => {
            response += `• ${bet.bet_amount}💎 on ${bet.bet_outcome.toUpperCase()}\n`;
        });
    }
    
    if (credits.canClaimDaily) {
        response += '\n🎁 You can claim your daily 100💎 bonus!';
    }
    
    await interaction.reply({
        content: response,
        ephemeral: true
    });
}

async function handleDailyCredits(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    
    const result = await bettingManager.claimDailyCredits(userId, guildId);
    
    if (result.success) {
        await interaction.reply({
            content: `🎁 ${result.message} New balance: ${result.newBalance}💎`,
            ephemeral: true
        });
    } else {
        await interaction.reply({
            content: `❌ ${result.message}`,
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
        response += `⏰ **Betting Window:** ${timeText > 0 ? `${timeText} remaining` : 'CLOSED'}\n`;
        
        // Show user's active bets for this game
        const userId = interaction.user.id;
        const activeBets = await bettingManager.getUserActiveBets(userId);
        const gameBets = activeBets.filter(bet => bet.game_id === gameId);
        
        if (gameBets.length > 0) {
            response += `\n🎯 **Your Bets:**\n`;
            gameBets.forEach(bet => {
                response += `• ${bet.bet_amount}💎 on ${bet.bet_outcome.toUpperCase()}\n`;
            });
        } else {
            response += `\n💡 **No bets placed** - Use the buttons above to bet!`;
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

// Daily credit distribution system
async function distributeDailyCredits() {
    if (!bettingManager.persistence.databaseAvailable) {
        console.log('⚠️ Skipping daily credit distribution - database not available');
        return;
    }

    try {
        console.log('🎁 Starting daily credit distribution...');
        
        const today = new Date().toISOString().split('T')[0];
        
        // Get all users who haven't claimed today
        const result = await bettingManager.persistence.pool.query(`
            SELECT user_id, guild_id, balance 
            FROM user_credits 
            WHERE last_daily_claim IS NULL OR last_daily_claim < $1
        `, [today]);
        
        let distributionCount = 0;
        
        for (const user of result.rows) {
            try {
                await bettingManager.persistence.pool.query(`
                    UPDATE user_credits 
                    SET balance = balance + 100, 
                        last_daily_claim = $3,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE user_id = $1 AND guild_id = $2
                `, [user.user_id, user.guild_id, today]);
                
                distributionCount++;
            } catch (error) {
                console.error(`Error distributing credits to user ${user.user_id}:`, error);
            }
        }
        
        console.log(`✅ Daily credit distribution complete: ${distributionCount} users received 100💎`);
    } catch (error) {
        console.error('❌ Error during daily credit distribution:', error);
    }
}

// Schedule daily credit distribution at midnight UTC
cron.schedule('0 0 * * *', async () => {
    console.log('🕛 Midnight UTC - Running daily credit distribution...');
    await distributeDailyCredits();
});

// Run initial distribution check on startup (in case bot was offline at midnight)
setTimeout(async () => {
    console.log('🔄 Running startup credit distribution check...');
    await distributeDailyCredits();
}, 5000); // Wait 5 seconds after startup

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    tracker.stopTracking();
    client.destroy();
    process.exit(0);
});

client.login(config.discord.token);