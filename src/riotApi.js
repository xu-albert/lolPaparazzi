const axios = require('axios');

class RiotAPI {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseURL = 'https://na1.api.riotgames.com/lol';
    }

    async getSummonerByName(summonerName) {
        try {
            const response = await axios.get(
                `${this.baseURL}/summoner/v4/summoners/by-name/${encodeURIComponent(summonerName)}`,
                {
                    headers: {
                        'X-Riot-Token': this.apiKey
                    }
                }
            );
            return response.data;
        } catch (error) {
            console.error('Error fetching summoner:', error.response?.data || error.message);
            throw error;
        }
    }

    async getCurrentGame(summonerId) {
        try {
            const response = await axios.get(
                `${this.baseURL}/spectator/v4/active-games/by-summoner/${summonerId}`,
                {
                    headers: {
                        'X-Riot-Token': this.apiKey
                    }
                }
            );
            return response.data;
        } catch (error) {
            if (error.response?.status === 404) {
                return null;
            }
            console.error('Error fetching current game:', error.response?.data || error.message);
            throw error;
        }
    }

    async getRankInfo(summonerId) {
        try {
            const response = await axios.get(
                `${this.baseURL}/league/v4/entries/by-summoner/${summonerId}`,
                {
                    headers: {
                        'X-Riot-Token': this.apiKey
                    }
                }
            );
            return response.data;
        } catch (error) {
            console.error('Error fetching rank info:', error.response?.data || error.message);
            throw error;
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