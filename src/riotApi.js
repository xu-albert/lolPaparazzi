const axios = require('axios');
const ApiRateLimiter = require('./apiRateLimiter');

class RiotAPI {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseURL = 'https://na1.api.riotgames.com/lol';
        // Account API uses regional clusters: americas, asia, europe
        this.accountBaseURL = 'https://americas.api.riotgames.com/riot/account/v1';
        
        // Initialize rate limiter
        this.rateLimiter = new ApiRateLimiter({
            maxRequestsPerWindow: 90,
            windowSizeMs: 120000, // 2 minutes
            maxRetries: 3
        });
        
        // Champion data caching
        this.championMap = new Map(); // championId -> championName
        this.championDataLoaded = false;
        this.lastChampionUpdate = null;
        
        console.log('🚀 RiotAPI initialized with rate limiting');
    }
    
    // Get API usage statistics (for internal use)
    getApiStats() {
        return this.rateLimiter.getStats();
    }
    
    // Log detailed API statistics to console
    logDetailedStats() {
        const stats = this.getApiStats();
        console.log(`\n📊 ===== DETAILED API STATISTICS =====`);
        console.log(`🌐 Requests: ${stats.totalRequests} total (${stats.successfulRequests} success, ${stats.failedRequests} failed)`);
        console.log(`🚨 Rate Limits: ${stats.rateLimitedRequests} hit, Current: ${stats.rateLimitWindow}`);
        console.log(`🏆 Peak Usage: ${stats.peakRequestsInWindow}/${this.rateLimiter.maxRequestsPerWindow} requests (${Math.round(stats.peakRequestsInWindow/this.rateLimiter.maxRequestsPerWindow*100)}% max)`);
        
        if (stats.peakRequestsTime) {
            console.log(`   Peak Time: ${stats.peakRequestsTime.toLocaleString()}`);
        }
        
        console.log(`💾 Cache: ${stats.cacheHitRate} hit rate, ${stats.cacheSize} entries, ${stats.cachedResponses} served`);
        console.log(`⚡ Performance: ${Math.round(stats.averageResponseTime)}ms avg, Queue: ${stats.queueSize}, Active: ${stats.activeRequests}`);
        console.log(`=====================================\n`);
        
        return stats;
    }
    
    // Cleanup method
    destroy() {
        if (this.rateLimiter) {
            this.rateLimiter.destroy();
        }
        console.log('🚫 RiotAPI destroyed');
    }

    async getSummonerByRiotId(gameName, tagLine = 'NA1') {
        try {
            console.log(`Looking up: ${gameName}#${tagLine}`);
            
            // Cache key for this summoner lookup
            const cacheKey = `summoner:${gameName}#${tagLine}`;
            
            // First get PUUID using Account API
            const accountURL = `${this.accountBaseURL}/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
            console.log(`Account API URL: ${accountURL}`);
            
            const accountResponse = await this.rateLimiter.queueRequest({
                method: 'GET',
                url: accountURL,
                headers: {
                    'X-Riot-Token': this.apiKey
                }
            }, {
                priority: 'high', // Summoner lookup is high priority
                cacheKey: `account:${gameName}#${tagLine}`,
                cacheTTL: 7200000 // Cache account data for 2 hours (rarely changes)
            });
            
            const puuid = accountResponse.data.puuid;
            console.log(`Found PUUID: ${puuid}`);
            
            // Then get summoner data using PUUID
            const summonerURL = `${this.baseURL}/summoner/v4/summoners/by-puuid/${puuid}`;
            console.log(`Summoner API URL: ${summonerURL}`);
            
            const summonerResponse = await this.rateLimiter.queueRequest({
                method: 'GET',
                url: summonerURL,
                headers: {
                    'X-Riot-Token': this.apiKey
                }
            }, {
                priority: 'high',
                cacheKey: `summoner:puuid:${puuid}`,
                cacheTTL: 7200000 // Cache summoner data for 2 hours (rarely changes)
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


    async getCurrentGame(puuid, bypassCache = false) {
        try {
            const response = await this.rateLimiter.queueRequest({
                method: 'GET',
                url: `${this.baseURL}/spectator/v5/active-games/by-summoner/${puuid}`,
                headers: {
                    'X-Riot-Token': this.apiKey
                }
            }, {
                priority: 'high', // Live game data is high priority
                cacheKey: `current-game:${puuid}`,
                cacheTTL: 30000, // Cache for 30 seconds (games change frequently)
                bypassCache: bypassCache
            });
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
                const response = await this.rateLimiter.queueRequest({
                    method: 'GET',
                    url: `${this.baseURL}/league/v4/entries/by-puuid/${summonerIdOrPuuid}`,
                    headers: {
                        'X-Riot-Token': this.apiKey
                    }
                }, {
                    priority: 'normal'
                    // No caching for rank data - needs to be fresh after games
                });
                console.log('Rank info retrieved using PUUID endpoint');
                return response.data;
            } catch (puuidError) {
                console.log('PUUID endpoint failed, trying summoner ID endpoint...');
                
                // Fallback to summoner ID endpoint
                const response = await this.rateLimiter.queueRequest({
                    method: 'GET',
                    url: `${this.baseURL}/league/v4/entries/by-summoner/${summonerIdOrPuuid}`,
                    headers: {
                        'X-Riot-Token': this.apiKey
                    }
                }, {
                    priority: 'normal'
                    // No caching for rank data - needs to be fresh after games  
                });
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

    isCasualGame(gameData) {
        if (!gameData || !gameData.gameQueueConfigId) return false;
        
        // Common casual game modes that players play during breaks from ranked
        const casualQueues = [
            450,  // ARAM (All Random All Mid)
            400,  // Normal Draft Pick
            430,  // Normal Blind Pick 
            490,  // Quickplay
            900,  // ARURF (All Random Ultra Rapid Fire)
            1900, // Pick URF
            1300, // Nexus Blitz
            1400  // Ultimate Spellbook
        ];
        
        return casualQueues.includes(gameData.gameQueueConfigId);
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
            
            const response = await this.rateLimiter.queueRequest({
                method: 'GET',
                url: url,
                headers: {
                    'X-Riot-Token': this.apiKey
                }
            }, {
                priority: 'normal',
                cacheKey: `match-history:${puuid}:${count}:${startTime ? startTime.getTime() : 'all'}`,
                cacheTTL: 1800000 // Cache match history for 30 minutes (less frequent changes)
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
            const response = await this.rateLimiter.queueRequest({
                method: 'GET',
                url: `https://americas.api.riotgames.com/lol/match/v5/matches/${matchId}`,
                headers: {
                    'X-Riot-Token': this.apiKey
                }
            }, {
                priority: 'normal',
                cacheKey: `match-details:${matchId}`,
                cacheTTL: 3600000 // Cache match details for 1 hour (they don't change)
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
        // op.gg doesn't support direct match links, so link to summoner's match history
        // Users can find the specific match in their recent games
        
        // Extract region from baseURL (e.g., 'na1' from 'https://na1.api.riotgames.com/lol')
        const regionMatch = this.baseURL.match(/https:\/\/([a-z0-9]+)\.api\.riotgames\.com/);
        let region = 'na'; // default fallback
        
        if (regionMatch) {
            const apiRegion = regionMatch[1];
            // Map API regions to op.gg regions
            const regionMap = {
                'na1': 'na',
                'euw1': 'euw',
                'eun1': 'eune',
                'kr': 'kr',
                'jp1': 'jp',
                'br1': 'br',
                'la1': 'lan',
                'la2': 'las',
                'oc1': 'oce',
                'tr1': 'tr',
                'ru': 'ru'
            };
            region = regionMap[apiRegion] || 'na';
        }
        
        return `https://op.gg/summoners/${region}/${gameName}-${tagLine}`;
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
            // Use direct axios calls for Data Dragon (free API, no rate limiting needed)
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

    // Enhanced game analysis methods for betting system
    async getChampionSpecificStats(puuid, championName, gameCount = 10) {
        try {
            console.log(`📊 Getting champion stats for ${championName} (last ${gameCount} games)`);
            
            // Get recent match history
            const matchIds = await this.getMatchHistory(puuid, null, 20); // Get more to filter by champion
            const championGames = [];
            
            for (const matchId of matchIds) {
                if (championGames.length >= gameCount) break;
                
                const matchData = await this.getMatchDetails(matchId);
                if (!matchData) continue;
                
                const playerStats = await this.getPlayerMatchStats(matchData, puuid);
                if (!playerStats) continue;
                
                // Only include games with the specified champion
                if (playerStats.championName === championName && playerStats.queueType === 420) { // Ranked Solo
                    championGames.push(playerStats);
                }
            }
            
            if (championGames.length === 0) {
                return {
                    gamesPlayed: 0,
                    winrate: 0,
                    avgKDA: 0,
                    avgCS: 0,
                    recentForm: 'No recent games'
                };
            }
            
            // Calculate statistics
            const wins = championGames.filter(game => game.win).length;
            const winrate = Math.round((wins / championGames.length) * 100);
            
            const totalKDA = championGames.reduce((sum, game) => {
                const kda = game.kda === 'Perfect' ? 99 : parseFloat(game.kda);
                return sum + kda;
            }, 0);
            const avgKDA = (totalKDA / championGames.length).toFixed(2);
            
            const totalCS = championGames.reduce((sum, game) => sum + parseFloat(game.csPerMin), 0);
            const avgCS = (totalCS / championGames.length).toFixed(1);
            
            // Recent form (last 5 games)
            const recentGames = championGames.slice(0, Math.min(5, championGames.length));
            const recentWins = recentGames.filter(game => game.win).length;
            const recentForm = `${recentWins}W-${recentGames.length - recentWins}L`;
            
            return {
                gamesPlayed: championGames.length,
                winrate,
                avgKDA: avgKDA === '99.00' ? 'Perfect' : avgKDA,
                avgCS,
                recentForm: `${recentForm} in last ${recentGames.length}`
            };
        } catch (error) {
            console.error('Error getting champion-specific stats:', error);
            return {
                gamesPlayed: 0,
                winrate: 0,
                avgKDA: 0,
                avgCS: 0,
                recentForm: 'Error loading stats'
            };
        }
    }

    async getPlayerRankedStats(puuid) {
        try {
            const rankInfo = await this.getRankInfo(puuid);
            const soloRank = rankInfo.find(entry => entry.queueType === 'RANKED_SOLO_5x5');
            
            if (!soloRank) {
                return {
                    rank: 'Unranked',
                    winrate: 0,
                    games: 0,
                    lp: 0
                };
            }
            
            const totalGames = soloRank.wins + soloRank.losses;
            const winrate = totalGames > 0 ? Math.round((soloRank.wins / totalGames) * 100) : 0;
            
            // Format rank display
            const apexTiers = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];
            const rankDisplay = apexTiers.includes(soloRank.tier) 
                ? soloRank.tier 
                : `${soloRank.tier} ${soloRank.rank}`;
            
            return {
                rank: rankDisplay,
                winrate,
                games: `${soloRank.wins}W-${soloRank.losses}L`,
                lp: soloRank.leaguePoints
            };
        } catch (error) {
            console.error('Error getting player ranked stats:', error);
            return {
                rank: 'Unknown',
                winrate: 0,
                games: '0W-0L',
                lp: 0
            };
        }
    }

    async analyzeCurrentGame(trackedSummoner, currentGame) {
        try {
            console.log(`🔍 Analyzing current game for betting system...`);
            
            const participants = currentGame.participants;
            const trackedParticipant = participants.find(p => p.puuid === trackedSummoner.puuid);
            
            if (!trackedParticipant) {
                throw new Error('Tracked player not found in current game');
            }
            
            // Get tracked player's champion
            const trackedChampion = await this.getChampionNameById(trackedParticipant.championId);
            
            // Get detailed stats for tracked player
            const [championStats, rankedStats] = await Promise.all([
                this.getChampionSpecificStats(trackedSummoner.puuid, trackedChampion, 10),
                this.getPlayerRankedStats(trackedSummoner.puuid)
            ]);
            
            // Analyze all participants
            const allPlayers = await Promise.all(
                participants.map(async (participant) => {
                    const championName = await this.getChampionNameById(participant.championId);
                    const playerRankedStats = await this.getPlayerRankedStats(participant.puuid);
                    
                    return {
                        ...participant,
                        championName,
                        rankedStats: playerRankedStats,
                        isTracked: participant.puuid === trackedSummoner.puuid
                    };
                })
            );
            
            // Separate teams
            const blueTeam = allPlayers.filter(p => p.teamId === 100);
            const redTeam = allPlayers.filter(p => p.teamId === 200);
            
            return {
                gameId: currentGame.gameId,
                gameStartTime: new Date(currentGame.gameStartTime),
                trackedPlayer: {
                    participant: trackedParticipant,
                    championName: trackedChampion,
                    championStats,
                    rankedStats,
                    summoner: trackedSummoner
                },
                teams: {
                    blue: blueTeam,
                    red: redTeam
                },
                allPlayers,
                gameLength: currentGame.gameLength || 0
            };
        } catch (error) {
            console.error('Error analyzing current game:', error);
            throw error;
        }
    }
}

module.exports = RiotAPI;