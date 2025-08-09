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

    // Modern Riot ID lookup using Account API
    async getSummonerByName(input) {
        // Require Riot ID format (gameName#tagLine)
        if (!input.includes('#')) {
            throw new Error('Please use the full Riot ID format: GameName#TAG (e.g., Melvinbung#NA1)');
        }
        
        const [gameName, tagLine] = input.split('#');
        if (!gameName.trim() || !tagLine.trim()) {
            throw new Error('Invalid Riot ID format. Use: GameName#TAG (e.g., Melvinbung#NA1)');
        }
        
        // All players now have Riot IDs - use Account API only
        return await this.getSummonerByRiotId(gameName.trim(), tagLine.trim());
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

    async getMatchHistory(puuid, startTime = null, count = 5) {
        try {
            let url = `https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&count=${count}`;
            
            // Add start time filter if provided (Unix timestamp)
            if (startTime) {
                const startTimestamp = Math.floor(startTime.getTime() / 1000);
                url += `&startTime=${startTimestamp}`;
            }
            
            const response = await axios.get(url, {
                headers: {
                    'X-Riot-Token': this.apiKey
                }
            });
            
            console.log(`Fetched ${response.data.length} recent matches`);
            return response.data;
        } catch (error) {
            console.error('Error fetching match history:', error.response?.data || error.message);
            return [];
        }
    }

    async getMatchDetails(matchId) {
        try {
            const response = await axios.get(
                `https://americas.api.riotgames.com/lol/match/v5/matches/${matchId}`,
                {
                    headers: {
                        'X-Riot-Token': this.apiKey
                    }
                }
            );
            
            return response.data;
        } catch (error) {
            console.error(`Error fetching match details for ${matchId}:`, error.response?.data || error.message);
            return null;
        }
    }

    async getPlayerMatchStats(matchData, puuid) {
        try {
            // Find the participant data for our player
            const participant = matchData.info.participants.find(p => p.puuid === puuid);
            if (!participant) {
                console.error('Player not found in match data');
                return null;
            }

            const gameDurationMinutes = Math.floor(matchData.info.gameDuration / 60);
            const totalCS = participant.totalMinionsKilled + (participant.neutralMinionsKilled || 0);
            const csPerMin = gameDurationMinutes > 0 ? (totalCS / gameDurationMinutes).toFixed(1) : '0.0';
            
            return {
                win: participant.win,
                championName: participant.championName,
                kills: participant.kills,
                deaths: participant.deaths,
                assists: participant.assists,
                kda: participant.deaths > 0 ? ((participant.kills + participant.assists) / participant.deaths).toFixed(2) : 'Perfect',
                cs: totalCS,
                csPerMin: csPerMin,
                gameDuration: `${Math.floor(gameDurationMinutes)}:${(matchData.info.gameDuration % 60).toString().padStart(2, '0')}`,
                gameMode: matchData.info.gameMode,
                queueType: matchData.info.queueId,
                matchId: matchData.metadata.matchId
            };
        } catch (error) {
            console.error('Error parsing player match stats:', error);
            return null;
        }
    }

    createOpGGUrl(gameName, tagLine, matchId) {
        // Extract the NA1_ prefix and match ID number for op.gg URL
        const matchNumber = matchId.replace('NA1_', '');
        return `https://op.gg/summoners/na/${gameName}-${tagLine}/matches/${matchNumber}`;
    }

    // Simple champion ID to name mapping for most common champions
    getChampionNameById(championId) {
        const championMap = {
            1: 'Annie', 2: 'Olaf', 3: 'Galio', 4: 'Twisted Fate', 5: 'Xin Zhao',
            6: 'Urgot', 7: 'LeBlanc', 8: 'Vladimir', 9: 'Fiddlesticks', 10: 'Kayle',
            11: 'Master Yi', 12: 'Alistar', 13: 'Ryze', 14: 'Sion', 15: 'Sivir',
            16: 'Soraka', 17: 'Teemo', 18: 'Tristana', 19: 'Warwick', 20: 'Nunu & Willump',
            21: 'Miss Fortune', 22: 'Ashe', 23: 'Tryndamere', 24: 'Jax', 25: 'Morgana',
            26: 'Zilean', 27: 'Singed', 28: 'Evelynn', 29: 'Twitch', 30: 'Karthus',
            31: "Cho'Gath", 32: 'Amumu', 33: 'Rammus', 34: 'Anivia', 35: 'Shaco',
            36: 'Dr. Mundo', 37: 'Sona', 38: 'Kassadin', 39: 'Irelia', 40: 'Janna',
            41: 'Gangplank', 42: 'Corki', 43: 'Karma', 44: 'Taric', 45: 'Veigar',
            48: 'Trundle', 50: 'Swain', 51: 'Caitlyn', 53: 'Blitzcrank', 54: 'Malphite',
            55: 'Katarina', 56: 'Nocturne', 57: 'Maokai', 58: 'Renekton', 59: 'Jarvan IV',
            60: 'Elise', 61: 'Orianna', 62: 'Wukong', 63: 'Brand', 64: 'Lee Sin',
            67: 'Vayne', 68: 'Rumble', 69: 'Cassiopeia', 72: 'Skarner', 74: 'Heimerdinger',
            75: 'Nasus', 76: 'Nidalee', 77: 'Udyr', 78: 'Poppy', 79: 'Gragas',
            80: 'Pantheon', 81: 'Ezreal', 82: 'Mordekaiser', 83: 'Yorick', 84: 'Akali',
            85: 'Kennen', 86: 'Garen', 89: 'Leona', 90: 'Malzahar', 91: 'Talon',
            92: 'Riven', 96: "Kog'Maw", 98: 'Shen', 99: 'Lux', 101: 'Xerath',
            102: 'Shyvana', 103: 'Ahri', 104: 'Graves', 105: 'Fizz', 106: 'Volibear',
            107: 'Rengar', 110: 'Varus', 111: 'Nautilus', 112: 'Viktor', 113: 'Sejuani',
            114: 'Fiora', 115: 'Ziggs', 117: 'Lulu', 119: 'Draven', 120: 'Hecarim',
            121: "Kha'Zix", 122: 'Darius', 123: 'Jayce', 126: 'Jayce', 127: 'Lissandra',
            131: 'Diana', 133: 'Quinn', 134: 'Syndra', 136: 'Aurelion Sol', 141: 'Kayn',
            142: 'Zoe', 143: 'Zyra', 144: 'Kai\'Sa', 145: 'Ekko', 150: 'Gnar',
            154: 'Zac', 157: 'Yasuo', 161: "Vel'Koz", 163: 'Taliyah', 164: 'Camille',
            166: 'Akshan', 200: 'Bel\'Veth', 201: 'Braum', 202: 'Jhin', 203: 'Kindred',
            221: 'Zeri', 222: 'Jinx', 223: 'Tahm Kench', 234: 'Viego', 235: 'Senna',
            236: 'Lucian', 238: 'Zed', 240: 'Kled', 245: 'Ekko', 246: 'Qiyana',
            254: 'Vi', 266: 'Aatrox', 267: 'Nami', 268: 'Azir', 350: 'Yuumi',
            360: 'Samira', 412: 'Thresh', 420: 'Illaoi', 421: "Rek'Sai", 427: 'Ivern',
            429: 'Kalista', 432: 'Bard', 516: 'Ornn', 517: 'Sylas', 518: 'Neeko',
            523: 'Aphelios', 526: 'Rell', 555: 'Pyke', 777: 'Yone', 875: 'Sett',
            876: 'Lillia', 887: 'Gwen', 888: 'Renata Glasc', 895: 'Nilah', 897: 'K\'Sante',
            901: 'Smolder', 910: 'Hwei', 950: 'Naafiri'
        };
        
        return championMap[championId] || `Champion ${championId}`;
    }
}

module.exports = RiotAPI;