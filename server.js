const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const xml2js = require('xml2js');

const app = express();
const PORT = process.env.PORT || 3001;

// Simple in-memory cache (5 minute TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// CORS configuration - allow your frontend domains
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  process.env.FRONTEND_URL, // Set this in Render environment variables
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    // Check if origin is allowed or matches pattern
    if (allowedOrigins.includes(origin) || 
        origin.includes('vercel.app') || 
        origin.includes('netlify.app') ||
        origin.includes('github.io')) {
      return callback(null, true);
    }
    
    callback(null, true); // Allow all for now - tighten in production if needed
  },
  credentials: true
}));

app.use(express.json());

// Cache helper functions
function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function setCache(key, data) {
  cache.set(key, {
    data,
    expiry: Date.now() + CACHE_TTL
  });
}

// Health check / root endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    message: 'Upwork RSS Proxy Server',
    version: '1.0.0',
    endpoints: {
      'GET /': 'Health check',
      'GET /api/upwork/search?keyword=<keyword>': 'Search by keyword',
      'GET /api/upwork/category?category=<category>': 'Search by category',
      'POST /api/upwork/batch': 'Batch search multiple keywords'
    },
    cacheStatus: `${cache.size} items cached`
  });
});

// Search Upwork by keyword
app.get('/api/upwork/search', async (req, res) => {
  const { keyword } = req.query;
  
  if (!keyword) {
    return res.status(400).json({ error: 'Keyword parameter is required' });
  }
  
  const cacheKey = `search:${keyword.toLowerCase()}`;
  const cached = getCached(cacheKey);
  
  if (cached) {
    console.log(`Cache hit for: ${keyword}`);
    return res.json({ ...cached, cached: true });
  }
  
  const url = `https://www.upwork.com/ab/feed/jobs/rss?q=${encodeURIComponent(keyword)}&sort=recency`;
  
  try {
    console.log(`Fetching: ${keyword}`);
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; UpworkTracker/1.0)'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Upwork returned status ${response.status}`);
    }
    
    const xmlText = await response.text();
    
    const parser = new xml2js.Parser();
    parser.parseString(xmlText, (err, result) => {
      if (err) {
        console.error('XML parsing error:', err);
        return res.status(500).json({ error: 'Failed to parse RSS feed' });
      }
      
      const responseData = {
        success: true,
        keyword: keyword,
        data: result,
        timestamp: new Date().toISOString()
      };
      
      setCache(cacheKey, responseData);
      res.json(responseData);
    });
    
  } catch (error) {
    console.error('Error fetching from Upwork:', error.message);
    res.status(500).json({ 
      error: error.message,
      url: url
    });
  }
});

// Search Upwork by category
app.get('/api/upwork/category', async (req, res) => {
  const { category } = req.query;
  
  if (!category) {
    return res.status(400).json({ error: 'Category parameter is required' });
  }
  
  const cacheKey = `category:${category.toLowerCase()}`;
  const cached = getCached(cacheKey);
  
  if (cached) {
    return res.json({ ...cached, cached: true });
  }
  
  const url = `https://www.upwork.com/ab/feed/jobs/rss?category2=${encodeURIComponent(category)}&sort=recency`;
  
  try {
    console.log(`Fetching category: ${category}`);
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; UpworkTracker/1.0)'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Upwork returned status ${response.status}`);
    }
    
    const xmlText = await response.text();
    
    const parser = new xml2js.Parser();
    parser.parseString(xmlText, (err, result) => {
      if (err) {
        console.error('XML parsing error:', err);
        return res.status(500).json({ error: 'Failed to parse RSS feed' });
      }
      
      const responseData = {
        success: true,
        category: category,
        data: result,
        timestamp: new Date().toISOString()
      };
      
      setCache(cacheKey, responseData);
      res.json(responseData);
    });
    
  } catch (error) {
    console.error('Error fetching from Upwork:', error.message);
    res.status(500).json({ 
      error: error.message,
      url: url
    });
  }
});

// Batch search with multiple keywords
app.post('/api/upwork/batch', async (req, res) => {
  const { keywords } = req.body;
  
  if (!keywords || !Array.isArray(keywords)) {
    return res.status(400).json({ error: 'Keywords array is required' });
  }
  
  try {
    const results = await Promise.all(
      keywords.slice(0, 10).map(async (keyword) => {
        const cacheKey = `search:${keyword.toLowerCase()}`;
        const cached = getCached(cacheKey);
        
        if (cached) {
          return { keyword, data: cached.data, cached: true };
        }
        
        const url = `https://www.upwork.com/ab/feed/jobs/rss?q=${encodeURIComponent(keyword)}&sort=recency`;
        
        try {
          const response = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; UpworkTracker/1.0)'
            }
          });
          const xmlText = await response.text();
          
          return new Promise((resolve) => {
            const parser = new xml2js.Parser();
            parser.parseString(xmlText, (err, result) => {
              if (err) {
                resolve({ keyword, error: err.message });
              } else {
                setCache(cacheKey, { data: result });
                resolve({ keyword, data: result });
              }
            });
          });
        } catch (error) {
          return { keyword, error: error.message };
        }
      })
    );
    
    res.json({
      success: true,
      results: results,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Batch fetch error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Clear cache endpoint (optional, for admin use)
app.post('/api/cache/clear', (req, res) => {
  cache.clear();
  res.json({ success: true, message: 'Cache cleared' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   Upwork RSS Proxy Server v1.0.0                 ║
║   Running on port ${PORT}                           ║
╚══════════════════════════════════════════════════╝

Environment: ${process.env.NODE_ENV || 'development'}
Frontend URL: ${process.env.FRONTEND_URL || 'Not configured'}

Ready to accept requests...
  `);
});
