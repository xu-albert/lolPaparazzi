const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { config, validateConfig } = require('./config');
const RiotAPI = require('./riotApi');
const PlayerTracker = require('./tracker');
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
    
    tracker.startTracking();
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

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
});

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    tracker.stopTracking();
    client.destroy();
    process.exit(0);
});

client.login(config.discord.token);