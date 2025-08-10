const axios = require('axios');

class ApiRateLimiter {
    constructor(options = {}) {
        // Rate limiting configuration
        this.maxRequestsPerWindow = options.maxRequestsPerWindow || 90; // Conservative limit (90/120s)
        this.windowSizeMs = options.windowSizeMs || 120000; // 2 minutes
        this.maxRetries = options.maxRetries || 3;
        this.baseRetryDelayMs = options.baseRetryDelayMs || 1000; // 1 second
        
        // Request queue and tracking
        this.requestQueue = [];
        this.activeRequests = new Map(); // Track in-flight requests
        this.requestHistory = []; // Track request timestamps for rate limiting
        this.isProcessing = false;
        
        // Caching system
        this.cache = new Map();
        this.cacheStats = {
            hits: 0,
            misses: 0,
            evictions: 0
        };
        
        // Monitoring
        this.stats = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            rateLimitedRequests: 0,
            cachedResponses: 0,
            averageResponseTime: 0,
            lastRequestTime: null
        };
        
        // Start processing queue
        this.startQueueProcessor();
        
        // Cleanup expired cache entries every 5 minutes
        this.cacheCleanupInterval = setInterval(() => {
            this.cleanupExpiredCache();
        }, 300000);
        
        console.log(`🚦 ApiRateLimiter initialized: ${this.maxRequestsPerWindow} requests per ${this.windowSizeMs / 1000}s`);
    }
    
    /**
     * Add a request to the queue
     * @param {Object} requestConfig - Axios request configuration
     * @param {Object} options - Additional options (priority, cacheKey, cacheTTL)
     * @returns {Promise} - Promise that resolves with the response
     */
    async queueRequest(requestConfig, options = {}) {
        return new Promise((resolve, reject) => {
            const request = {
                id: this.generateRequestId(),
                config: requestConfig,
                options: {
                    priority: options.priority || 'normal', // high, normal, low
                    cacheKey: options.cacheKey,
                    cacheTTL: options.cacheTTL || 300000, // 5 minutes default
                    retryCount: 0,
                    ...options
                },
                resolve,
                reject,
                timestamp: Date.now()
            };
            
            // Check cache first (unless bypassed)
            if (request.options.cacheKey && !request.options.bypassCache) {
                const cachedResponse = this.getFromCache(request.options.cacheKey);
                if (cachedResponse) {
                    this.stats.cachedResponses++;
                    this.cacheStats.hits++;
                    resolve(cachedResponse);
                    return;
                }
                this.cacheStats.misses++;
            }
            
            // Add to queue with priority ordering
            this.addToQueue(request);
            
            // Start processing if not already running
            if (!this.isProcessing) {
                this.processQueue();
            }
        });
    }
    
    addToQueue(request) {
        // Insert based on priority
        const priorityOrder = { high: 0, normal: 1, low: 2 };
        const requestPriority = priorityOrder[request.options.priority];
        
        let insertIndex = this.requestQueue.length;
        for (let i = 0; i < this.requestQueue.length; i++) {
            const queuePriority = priorityOrder[this.requestQueue[i].options.priority];
            if (requestPriority < queuePriority) {
                insertIndex = i;
                break;
            }
        }
        
        this.requestQueue.splice(insertIndex, 0, request);
        console.log(`📥 Queued ${request.options.priority} priority request (${request.id}). Queue size: ${this.requestQueue.length}`);
    }
    
    async processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;
        
        while (this.requestQueue.length > 0) {
            // Check if we can make a request (rate limiting)
            if (!this.canMakeRequest()) {
                const waitTime = this.getWaitTime();
                console.log(`⏳ Rate limit reached. Waiting ${waitTime}ms before next request`);
                await this.sleep(waitTime);
                continue;
            }
            
            const request = this.requestQueue.shift();
            await this.executeRequest(request);
        }
        
        this.isProcessing = false;
    }
    
    async executeRequest(request) {
        const startTime = Date.now();
        this.activeRequests.set(request.id, request);
        this.stats.totalRequests++;
        this.stats.lastRequestTime = startTime;
        
        try {
            console.log(`🌐 Executing API request: ${request.config.method || 'GET'} ${request.config.url}`);
            
            const response = await axios(request.config);
            
            // Record successful request
            this.recordRequest(startTime);
            this.stats.successfulRequests++;
            
            // Cache response if caching is enabled and not bypassed
            if (request.options.cacheKey && !request.options.bypassCache) {
                this.setCache(request.options.cacheKey, response.data, request.options.cacheTTL);
            }
            
            // Update average response time
            const responseTime = Date.now() - startTime;
            this.updateAverageResponseTime(responseTime);
            
            request.resolve(response);
            
        } catch (error) {
            await this.handleRequestError(request, error, startTime);
        } finally {
            this.activeRequests.delete(request.id);
        }
    }
    
    async handleRequestError(request, error, startTime) {
        const responseTime = Date.now() - startTime;
        this.updateAverageResponseTime(responseTime);
        
        // Handle rate limiting (429)
        if (error.response && error.response.status === 429) {
            this.stats.rateLimitedRequests++;
            console.log(`⚠️ Rate limited! Request ${request.id}`);
            
            // Get retry-after header or use exponential backoff
            const retryAfter = error.response.headers['retry-after'];
            const delay = retryAfter ? parseInt(retryAfter) * 1000 : this.calculateBackoffDelay(request.options.retryCount);
            
            if (request.options.retryCount < this.maxRetries) {
                request.options.retryCount++;
                console.log(`🔄 Retrying request ${request.id} in ${delay}ms (attempt ${request.options.retryCount})`);
                
                setTimeout(() => {
                    this.addToQueue(request);
                    if (!this.isProcessing) {
                        this.processQueue();
                    }
                }, delay);
                return;
            }
        }
        
        // Handle other errors
        this.stats.failedRequests++;
        console.error(`❌ Request ${request.id} failed after ${request.options.retryCount} retries:`, error.message);
        request.reject(error);
    }
    
    canMakeRequest() {
        this.cleanupOldRequests();
        return this.requestHistory.length < this.maxRequestsPerWindow;
    }
    
    getWaitTime() {
        if (this.requestHistory.length === 0) return 0;
        
        const oldestRequest = this.requestHistory[0];
        const timeUntilExpiry = (oldestRequest + this.windowSizeMs) - Date.now();
        return Math.max(timeUntilExpiry + 100, 1000); // Add small buffer
    }
    
    recordRequest(timestamp) {
        this.requestHistory.push(timestamp);
        this.cleanupOldRequests();
    }
    
    cleanupOldRequests() {
        const cutoff = Date.now() - this.windowSizeMs;
        const initialLength = this.requestHistory.length;
        this.requestHistory = this.requestHistory.filter(timestamp => timestamp > cutoff);
        
        if (this.requestHistory.length !== initialLength) {
            console.log(`🧹 Cleaned up ${initialLength - this.requestHistory.length} old request records`);
        }
    }
    
    calculateBackoffDelay(retryCount) {
        // Exponential backoff: 1s, 2s, 4s, 8s...
        return this.baseRetryDelayMs * Math.pow(2, retryCount);
    }
    
    // Caching methods
    setCache(key, data, ttl) {
        const expiry = Date.now() + ttl;
        this.cache.set(key, {
            data: data,
            expiry: expiry,
            createdAt: Date.now()
        });
        console.log(`💾 Cached response for key: ${key} (TTL: ${ttl / 1000}s)`);
    }
    
    getFromCache(key) {
        const cached = this.cache.get(key);
        if (!cached) return null;
        
        if (Date.now() > cached.expiry) {
            this.cache.delete(key);
            this.cacheStats.evictions++;
            return null;
        }
        
        console.log(`🎯 Cache hit for key: ${key}`);
        return { data: cached.data };
    }
    
    cleanupExpiredCache() {
        const now = Date.now();
        let evicted = 0;
        
        for (const [key, cached] of this.cache.entries()) {
            if (now > cached.expiry) {
                this.cache.delete(key);
                evicted++;
            }
        }
        
        if (evicted > 0) {
            this.cacheStats.evictions += evicted;
            console.log(`🧹 Evicted ${evicted} expired cache entries`);
        }
    }
    
    updateAverageResponseTime(responseTime) {
        if (this.stats.averageResponseTime === 0) {
            this.stats.averageResponseTime = responseTime;
        } else {
            // Simple moving average
            this.stats.averageResponseTime = (this.stats.averageResponseTime * 0.9) + (responseTime * 0.1);
        }
    }
    
    // Utility methods
    generateRequestId() {
        return Math.random().toString(36).substr(2, 9);
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    startQueueProcessor() {
        // Process queue every second
        this.queueProcessorInterval = setInterval(() => {
            if (!this.isProcessing && this.requestQueue.length > 0) {
                this.processQueue();
            }
        }, 1000);
    }
    
    // Public API for monitoring
    getStats() {
        const cacheHitRate = this.cacheStats.hits + this.cacheStats.misses > 0 
            ? (this.cacheStats.hits / (this.cacheStats.hits + this.cacheStats.misses) * 100).toFixed(2)
            : 0;
            
        return {
            ...this.stats,
            queueSize: this.requestQueue.length,
            activeRequests: this.activeRequests.size,
            cacheSize: this.cache.size,
            cacheHitRate: `${cacheHitRate}%`,
            cacheStats: this.cacheStats,
            rateLimitWindow: `${this.requestHistory.length}/${this.maxRequestsPerWindow} requests in last ${this.windowSizeMs / 1000}s`
        };
    }
    
    // Cleanup
    destroy() {
        if (this.queueProcessorInterval) {
            clearInterval(this.queueProcessorInterval);
        }
        if (this.cacheCleanupInterval) {
            clearInterval(this.cacheCleanupInterval);
        }
        
        // Reject all pending requests
        this.requestQueue.forEach(request => {
            request.reject(new Error('ApiRateLimiter destroyed'));
        });
        
        this.cache.clear();
        console.log('🚫 ApiRateLimiter destroyed');
    }
}

module.exports = ApiRateLimiter;