require('dotenv').config();

const config = {
    discord: {
        token: process.env.DISCORD_TOKEN
    },
    riot: {
        apiKey: process.env.RIOT_API_KEY
    }
};

function validateConfig() {
    const missing = [];
    
    if (!config.discord.token) {
        missing.push('DISCORD_TOKEN');
    }
    
    if (!config.riot.apiKey) {
        missing.push('RIOT_API_KEY');
    }
    
    if (missing.length > 0) {
        console.error('Missing required environment variables:');
        missing.forEach(var_name => console.error(`  - ${var_name}`));
        console.error('\nPlease create a .env file with the required variables.');
        console.error('See .env.example for the template.');
        process.exit(1);
    }
}

module.exports = { config, validateConfig };