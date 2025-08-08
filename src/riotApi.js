const axios = require('axios');

class RiotAPI {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseURL = 'https://na1.api.riotgames.com/lol';
        // Account API uses regional clusters: americas, asia, europe
        this.accountBaseURL = 'https://americas.api.riotgames.com/riot/account/v1';
    }

    async getSummonerByRiotId(gameName, tagLine = 'NA1') {
        try {
            console.log(`Looking up: ${gameName}#${tagLine}`);
            
            // First get PUUID using Account API
            const accountURL = `${this.accountBaseURL}/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
            console.log(`Account API URL: ${accountURL}`);
            
            const accountResponse = await axios.get(accountURL, {
                headers: {
                    'X-Riot-Token': this.apiKey
                }
            });
            
            const puuid = accountResponse.data.puuid;
            console.log(`Found PUUID: ${puuid}`);
            
            // Then get summoner data using PUUID
            const summonerURL = `${this.baseURL}/summoner/v4/summoners/by-puuid/${puuid}`;
            console.log(`Summoner API URL: ${summonerURL}`);
            
            const summonerResponse = await axios.get(summonerURL, {
                headers: {
                    'X-Riot-Token': this.apiKey
                }
            });
            
            // Add the riot ID info to the response
            const summonerData = summonerResponse.data;
            summonerData.gameName = accountResponse.data.gameName;
            summonerData.tagLine = accountResponse.data.tagLine;
            
            console.log('Raw summoner API response:', summonerResponse.data);
            
            // Check if we have an id field, if not, this might be an API issue
            if (!summonerResponse.data.id) {
                console.error('WARNING: Summoner API response missing ID field!');
                console.log('Response keys:', Object.keys(summonerResponse.data));
            }
            
            console.log(`Successfully found summoner: ${summonerData.gameName}#${summonerData.tagLine}`);
            return summonerData;
        } catch (error) {
            console.error('Error fetching summoner:', {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                message: error.message,
                url: error.config?.url
            });
            throw error;
        }
    }

    // Try new Account API first, fallback to legacy if needed
    async getSummonerByName(input) {
        // Require Riot ID format (gameName#tagLine)
        if (!input.includes('#')) {
            throw new Error('Please use the full Riot ID format: GameName#TAG (e.g., Melvinbung#NA1)');
        }
        
        const [gameName, tagLine] = input.split('#');
        if (!gameName.trim() || !tagLine.trim()) {
            throw new Error('Invalid Riot ID format. Use: GameName#TAG (e.g., Melvinbung#NA1)');
        }
        
        try {
            // Try new Account API first
            return await this.getSummonerByRiotId(gameName.trim(), tagLine.trim());
        } catch (error) {
            // If Account API fails (403/401), try legacy method for NA1 only
            if ((error.response?.status === 403 || error.response?.status === 401) && tagLine.trim().toUpperCase() === 'NA1') {
                console.log('Account API not available, trying legacy method for NA1...');
                return await this.getSummonerByLegacyName(gameName.trim());
            }
            throw error;
        }
    }

    // Legacy fallback for NA1 region only
    async getSummonerByLegacyName(summonerName) {
        try {
            console.log(`Trying legacy lookup for: ${summonerName}`);
            const response = await axios.get(
                `${this.baseURL}/summoner/v4/summoners/by-name/${encodeURIComponent(summonerName)}`,
                {
                    headers: {
                        'X-Riot-Token': this.apiKey
                    }
                }
            );
            
            const summonerData = response.data;
            // Add fake riot ID data for display
            summonerData.gameName = summonerName;
            summonerData.tagLine = 'NA1';
            
            console.log(`Legacy lookup successful: ${summonerData.name}`);
            return summonerData;
        } catch (error) {
            console.error('Legacy API also failed:', error.response?.data || error.message);
            throw new Error(`Could not find summoner "${summonerName}#NA1". Please check the spelling and try again.`);
        }
    }

    async getCurrentGame(puuid) {
        try {
            const response = await axios.get(
                `${this.baseURL}/spectator/v5/active-games/by-summoner/${puuid}`,
                {
                    headers: {
                        'X-Riot-Token': this.apiKey
                    }
                }
            );
            return response.data;
        } catch (error) {
            if (error.response?.status === 404) {
                // Player not in game - this is normal
                return null;
            }
            console.error('Error fetching current game:', error.response?.data || error.message);
            return null; // Don't throw, just return null to continue tracking
        }
    }

    async getRankInfo(summonerIdOrPuuid) {
        try {
            if (!summonerIdOrPuuid) {
                console.log('No summoner ID/PUUID available for rank lookup');
                return [];
            }
            
            // Try using PUUID endpoint first (more reliable)
            try {
                const response = await axios.get(
                    `${this.baseURL}/league/v4/entries/by-puuid/${summonerIdOrPuuid}`,
                    {
                        headers: {
                            'X-Riot-Token': this.apiKey
                        }
                    }
                );
                console.log('Rank info retrieved using PUUID endpoint');
                return response.data;
            } catch (puuidError) {
                console.log('PUUID endpoint failed, trying summoner ID endpoint...');
                
                // Fallback to summoner ID endpoint
                const response = await axios.get(
                    `${this.baseURL}/league/v4/entries/by-summoner/${summonerIdOrPuuid}`,
                    {
                        headers: {
                            'X-Riot-Token': this.apiKey
                        }
                    }
                );
                console.log('Rank info retrieved using summoner ID endpoint');
                return response.data;
            }
        } catch (error) {
            console.error('Error fetching rank info:', error.response?.data || error.message);
            // Return empty array instead of throwing, so setup can continue
            return [];
        }
    }

    isRankedSoloGame(gameData) {
        return gameData && gameData.gameQueueConfigId === 420;
    }


    formatRankInfo(rankData) {
        const soloRank = rankData.find(entry => entry.queueType === 'RANKED_SOLO_5x5');
        if (!soloRank) {
            return 'Unranked';
        }
        return `${soloRank.tier} ${soloRank.rank} (${soloRank.leaguePoints} LP)`;
    }
}

module.exports = RiotAPI;