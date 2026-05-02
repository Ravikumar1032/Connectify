import { Message } from './schema';

const GEMINI_API_KEY = '';
const GEMINI_API_URL = '';

// Alternative API endpoints to try if the main one fails
const ALTERNATIVE_API_ENDPOINTS = [
  '',
  '', // Fallback to completions API
];

// Use a CORS proxy if needed to bypass DNS issues
// Uncomment and use this if you continue to have ERR_NAME_NOT_RESOLVED issues
// const CORS_PROXY = 'https://cors-anywhere.herokuapp.com/';
// const API_URL = `${CORS_PROXY}${OPENAI_API_URL}`;
const API_URL = GEMINI_API_URL;

interface ChatRequest {
  message: string;
  chatHistory?: Message[];
}

interface ChatResponse {
  message: string;
  error?: string;
}

// Fallback responses for when the API is unavailable
const FALLBACK_RESPONSES = [
  "I'm currently experiencing high demand. Please try again in a moment.",
  "I'm temporarily unavailable due to high traffic. Please try again later.",
  "I'm having trouble connecting to my knowledge base right now. Please try again in a few minutes.",
  "I'm currently processing many requests. Please try again shortly.",
  "I'm experiencing technical difficulties. Please try again later.",
  "I'm a bit overwhelmed with requests right now. Please try again in a moment.",
  "I'm taking a short break to process all the requests. Please try again in a minute.",
  "I'm experiencing high traffic. Please try again in a few moments.",
  "I'm currently at capacity. Please try again in a short while.",
  "I'm having trouble connecting to the AI service. Please try again later."
];

// Get a random fallback response
const getRandomFallbackResponse = (): string => {
  const randomIndex = Math.floor(Math.random() * FALLBACK_RESPONSES.length);
  return FALLBACK_RESPONSES[randomIndex];
};

// Enhanced rate limiter with token bucket algorithm
const rateLimiter = {
  lastRequestTime: 0,
  minTimeBetweenRequests: 2000, // 2 seconds between requests
  tokens: 5, // Start with 5 tokens
  maxTokens: 5, // Maximum 5 tokens
  tokenRefillRate: 1, // 1 token per 2 seconds
  
  canMakeRequest: function(): boolean {
    const now = Date.now();
    const timePassed = now - this.lastRequestTime;
    
    // Refill tokens based on time passed
    if (timePassed >= this.minTimeBetweenRequests) {
      const tokensToAdd = Math.floor(timePassed / this.minTimeBetweenRequests) * this.tokenRefillRate;
      this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
      this.lastRequestTime = now;
    }
    
    // Check if we have enough tokens
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    
    return false;
  },
  
  // Get time until next token is available
  getTimeUntilNextToken: function(): number {
    if (this.tokens > 0) return 0;
    
    const now = Date.now();
    const timePassed = now - this.lastRequestTime;
    const timeUntilNextToken = Math.max(0, this.minTimeBetweenRequests - timePassed);
    
    return timeUntilNextToken;
  }
};

// Request queue for handling rate limits
const requestQueue = {
  queue: [] as Array<() => Promise<ChatResponse>>,
  isProcessing: false,
  
  add: function(request: () => Promise<ChatResponse>): Promise<ChatResponse> {
    return new Promise((resolve) => {
      this.queue.push(async () => {
        const result = await request();
        resolve(result);
      });
      
      if (!this.isProcessing) {
        this.processQueue();
      }
    });
  },
  
  processQueue: async function() {
    if (this.queue.length === 0) {
      this.isProcessing = false;
      return;
    }
    
    this.isProcessing = true;
    const request = this.queue.shift();
    
    if (request) {
      await request();
      
      // Wait before processing next request
      await sleep(rateLimiter.minTimeBetweenRequests);
      this.processQueue();
    }
  }
};

// Exponential backoff for retries
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Retry with exponential backoff
const retryWithBackoff = async (
  fn: () => Promise<ChatResponse>,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<ChatResponse> => {
  let retries = 0;
  
  while (true) {
    try {
      return await fn();
    } catch (error) {
      retries++;
      
      if (retries >= maxRetries) {
        console.error(`Failed after ${maxRetries} retries:`, error);
        return {
          message: getRandomFallbackResponse(),
          error: 'Maximum retries exceeded. Please try again later.'
        };
      }
      
      // Calculate delay with exponential backoff
      const delay = initialDelay * Math.pow(2, retries - 1);
      console.log(`Retrying in ${delay}ms (attempt ${retries}/${maxRetries})`);
      await sleep(delay);
    }
  }
};

// Local cache for responses to reduce API calls
const responseCache = {
  cache: new Map<string, ChatResponse>(),
  maxSize: 100,
  
  get: function(key: string): ChatResponse | null {
    return this.cache.get(key) || null;
  },
  
  set: function(key: string, value: ChatResponse): void {
    if (this.cache.size >= this.maxSize) {
      // Remove oldest entry
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, value);
  }
};

// Generate a cache key for a request
const generateCacheKey = (request: ChatRequest): string => {
  const messageContent = request.message;
  const historyContent = request.chatHistory 
    ? request.chatHistory.map(msg => `${msg.role}:${msg.content}`).join('|')
    : '';
  
  return `${messageContent}|${historyContent}`;
};

// Format chat history for Gemini API
const formatChatHistoryForGemini = (chatHistory: Message[] = []): string => {
  return chatHistory.map(msg => {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    return `${role}: ${msg.content}`;
  }).join('\n');
};

// Main function to send a message to the API
export const sendMessage = async (request: ChatRequest): Promise<ChatResponse> => {
  console.log('Sending request to Gemini API:', {
    message: request.message,
    timestamp: new Date().toLocaleTimeString(),
  });

  // Check cache first
  const cacheKey = generateCacheKey(request);
  const cachedResponse = responseCache.get(cacheKey);
  if (cachedResponse) {
    console.log('Using cached response');
    return cachedResponse;
  }

  // Check rate limiter
  if (!rateLimiter.canMakeRequest()) {
    const timeUntilNextToken = rateLimiter.getTimeUntilNextToken();
    console.warn(`Rate limiter: Too many requests, waiting ${timeUntilNextToken}ms`);
    
    // Queue the request instead of returning a fallback immediately
    return requestQueue.add(async () => {
      await sleep(timeUntilNextToken);
      return sendMessage(request);
    });
  }

  // Function to make the actual API call
  const makeApiCall = async (): Promise<ChatResponse> => {
    try {
      // Format the chat history
      const chatHistory = formatChatHistoryForGemini(request.chatHistory);
      
      // Prepare the prompt with context
      let prompt = request.message;
      if (chatHistory) {
        prompt = `Previous conversation:\n${chatHistory}\n\nUser: ${request.message}`;
      }

      // Make the API call to Gemini
      const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }]
        })
      });

      console.log('API Response Status:', response.status);

      // Handle rate limit error (429)
      if (response.status === 429) {
        console.warn('Rate limit exceeded. Using fallback response.');
        throw new Error('Rate limit exceeded');
      }

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Gemini API error:', errorData);
        throw new Error(`API error: ${errorData.error?.message || 'Unknown error'}`);
      }

      const data = await response.json();
      console.log('API Success Response:', data);

      // Extract the response text from Gemini's format
      const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || 
                          'I apologize, but I could not generate a proper response.';
      
      const result = {
        message: responseText
      };
      
      // Cache the successful response
      responseCache.set(cacheKey, result);
      
      return result;
    } catch (error) {
      console.error('Error calling Gemini API:', error);
      throw error; // Re-throw to be caught by retry mechanism
    }
  };

  // Try with retry logic
  try {
    return await retryWithBackoff(makeApiCall);
  } catch (error) {
    console.error('All retry attempts failed:', error);
    return {
      message: getRandomFallbackResponse(),
      error: 'Failed to connect to the AI service. Please try again later.'
    };
  }
}; 
