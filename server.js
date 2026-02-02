const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

// Apify API configuration - TOKEN MUST BE SET IN ENVIRONMENT VARIABLES
const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
const APIFY_ACTOR_ID = 'raEfLcfFWJDO0vtIV';

if (!APIFY_API_TOKEN) {
  console.warn('WARNING: APIFY_API_TOKEN not set in environment variables!');
}

// Simple in-memory cache (10 minute TTL)
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) { cache.delete(key); return null; }
  return item.data;
}

function setCache(key, data) {
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL });
}

app.get('/', (req, res) => {
  res.json({ 
    status: 'running',
    message: 'Upwork Tracker Proxy Server (Apify)',
    version: '2.0.0',
    dataSource: 'Apify Upwork Scraper',
    tokenConfigured: !!APIFY_API_TOKEN
  });
});

async function runApifyActor(input) {
  if (!APIFY_API_TOKEN) {
    throw new Error('APIFY_API_TOKEN not configured');
  }
  
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_API_TOKEN}`;
  
  const runResponse = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  
  if (!runResponse.ok) throw new Error(`Apify API error: ${runResponse.status}`);
  
  const runData = await runResponse.json();
  const runId = runData.data.id;
  
  let attempts = 0;
  while (attempts < 30) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const statusResponse = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_API_TOKEN}`);
    const statusData = await statusResponse.json();
    
    if (statusData.data.status === 'SUCCEEDED') {
      const datasetId = statusData.data.defaultDatasetId;
      const itemsResponse = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_TOKEN}`);
      return await itemsResponse.json();
    } else if (statusData.data.status === 'FAILED' || statusData.data.status === 'ABORTED') {
      throw new Error(`Apify run ${statusData.data.status}`);
    }
    attempts++;
  }
  throw new Error('Apify run timed out');
}

app.get('/api/upwork/search', async (req, res) => {
  const { keyword, limit = 30 } = req.query;
  if (!keyword) return res.status(400).json({ error: 'Keyword required' });
  
  const cacheKey = `search:${keyword.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });
  
  try {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    const input = {
      limit: parseInt(limit),
      fromDate: weekAgo.toISOString().split('T')[0],
      toDate: today.toISOString().split('T')[0],
      'includeKeywords.keywords': [keyword],
      'includeKeywords.matchTitle': true,
      'includeKeywords.matchDescription': true
    };
    
    console.log(`Fetching: ${keyword}`);
    const jobs = await runApifyActor(input);
    
    const responseData = { success: true, keyword, count: jobs.length, jobs, timestamp: new Date().toISOString() };
    setCache(cacheKey, responseData);
    res.json(responseData);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/upwork/batch', async (req, res) => {
  const { keywords, limit = 100 } = req.body;
  if (!keywords || !Array.isArray(keywords)) return res.status(400).json({ error: 'Keywords array required' });
  
  const cacheKey = `batch:${keywords.sort().join(',')}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });
  
  try {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    const input = {
      limit: parseInt(limit),
      fromDate: weekAgo.toISOString().split('T')[0],
      toDate: today.toISOString().split('T')[0],
      'includeKeywords.keywords': keywords.slice(0, 10),
      'includeKeywords.matchTitle': true,
      'includeKeywords.matchDescription': true,
      'includeKeywords.matchSkills': true
    };
    
    console.log(`Batch fetch: ${keywords.join(', ')}`);
    const jobs = await runApifyActor(input);
    
    const responseData = { success: true, keywords, count: jobs.length, jobs, timestamp: new Date().toISOString() };
    setCache(cacheKey, responseData);
    res.json(responseData);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/upwork/category', async (req, res) => {
  const { category, limit = 50 } = req.query;
  if (!category) return res.status(400).json({ error: 'Category required' });
  
  const cacheKey = `category:${category}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });
  
  try {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    const input = {
      limit: parseInt(limit),
      fromDate: weekAgo.toISOString().split('T')[0],
      toDate: today.toISOString().split('T')[0],
      jobCategories: [category]
    };
    
    const jobs = await runApifyActor(input);
    const responseData = { success: true, category, count: jobs.length, jobs, timestamp: new Date().toISOString() };
    setCache(cacheKey, responseData);
    res.json(responseData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Upwork Tracker Proxy v2.0.0 running on port ${PORT}`);
  console.log(`Apify Token: ${APIFY_API_TOKEN ? 'Configured' : 'NOT SET - Add APIFY_API_TOKEN env var!'}`);
});
