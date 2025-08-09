const axios = require('axios');

class RiotAPI {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseURL = 'https://na1.api.riotgames.com/lol';
        // Account API uses regional clusters: americas, asia, europe
        this.accountBaseURL = 'https://americas.api.riotgames.com/riot/account/v1';
        
        // Champion data caching
        this.championMap = new Map(); // championId -> championName
        this.championDataLoaded = false;
        this.lastChampionUpdate = null;
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

    // Load champion data from Riot's Data Dragon API
    async loadChampionData() {
        try {
            // Check if we need to refresh (every 24 hours or on startup)
            const now = new Date();
            const needsRefresh = !this.championDataLoaded || 
                                !this.lastChampionUpdate || 
                                (now - this.lastChampionUpdate) > (24 * 60 * 60 * 1000);
            
            if (!needsRefresh) {
                return; // Data is still fresh
            }
            
            console.log('🔄 Loading champion data from Data Dragon...');
            
            // Get latest game version first
            const versionsResponse = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json');
            const latestVersion = versionsResponse.data[0];
            
            // Load champion data for latest version
            const championsResponse = await axios.get(
                `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/data/en_US/champion.json`
            );
            
            const championData = championsResponse.data.data;
            
            // Clear existing map and populate with fresh data
            this.championMap.clear();
            
            // Convert champion data to ID -> Name mapping
            for (const [championKey, championInfo] of Object.entries(championData)) {
                const championId = parseInt(championInfo.key);
                const championName = championInfo.name;
                this.championMap.set(championId, championName);
            }
            
            this.championDataLoaded = true;
            this.lastChampionUpdate = now;
            
            console.log(`✅ Loaded ${this.championMap.size} champions from Data Dragon (v${latestVersion})`);
            
        } catch (error) {
            console.error('❌ Error loading champion data from Data Dragon:', error.message);
            
            // Fallback to basic mapping if Data Dragon fails
            if (this.championMap.size === 0) {
                console.log('⚠️ Using fallback champion mapping');
                this.championMap = new Map([
                    [1, 'Annie'], [777, 'Yone'], [11, 'Master Yi'], [157, 'Yasuo'],
                    [64, 'Lee Sin'], [103, 'Ahri'], [81, 'Ezreal'], [22, 'Ashe']
                    // Add more common champions as needed
                ]);
            }
        }
    }

    // Get champion name by ID with automatic loading
    async getChampionNameById(championId) {
        // Ensure champion data is loaded
        await this.loadChampionData();
        
        // Look up champion name
        const championName = this.championMap.get(championId);
        
        if (championName) {
            return championName;
        }
        
        // If not found, try refreshing data (maybe new champion)
        if (this.championDataLoaded) {
            console.log(`🔍 Unknown champion ID ${championId}, refreshing data...`);
            this.championDataLoaded = false; // Force refresh
            await this.loadChampionData();
            
            // Try again after refresh
            const refreshedName = this.championMap.get(championId);
            if (refreshedName) {
                return refreshedName;
            }
        }
        
        // Final fallback
        return `Champion ${championId}`;
    }
}

module.exports = RiotAPI;