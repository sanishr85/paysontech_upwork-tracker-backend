const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const APIFY_ACTOR_ID = 'raEfLcfFWJDO0vtIV';

if (!APIFY_API_TOKEN) console.warn('WARNING: APIFY_API_TOKEN not set!');
if (!ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY not set!');

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

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
    message: 'PaysonTech Upwork Tracker API',
    version: '2.1.0',
    dataSource: 'Apify Upwork Scraper',
    apifyConfigured: !!APIFY_API_TOKEN,
    anthropicConfigured: !!ANTHROPIC_API_KEY
  });
});

async function runApifyActor(input) {
  if (!APIFY_API_TOKEN) throw new Error('APIFY_API_TOKEN not configured');
  
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

// Generate proposal endpoint
app.post('/api/generate-proposal', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
  }
  
  const { project, offering, allOfferings, template, skillGaps } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project data required' });
  }
  
  // Calculate cross-category skills
  const allOurSkills = allOfferings?.flatMap(o => o.skills || []) || [];
  const uniqueOurSkills = [...new Set(allOurSkills.map(s => s.toLowerCase()))];
  const projectSkills = (project.skills || []).map(s => s.toLowerCase());
  
  const crossCategoryMatched = [];
  const crossCategoryMissing = [];
  
  projectSkills.forEach((skill, i) => {
    const hasSkill = uniqueOurSkills.some(os => os.includes(skill) || skill.includes(os));
    if (hasSkill) crossCategoryMatched.push(project.skills[i]);
    else crossCategoryMissing.push(project.skills[i]);
  });
  
  // Calculate confidence with breakdown
  let confidence = 50;
  const confidenceBreakdown = [];
  
  // Skills coverage (up to 25 points)
  const skillCoverage = crossCategoryMatched.length / (projectSkills.length || 1);
  const skillPoints = Math.round(skillCoverage * 25);
  confidence += skillPoints;
  confidenceBreakdown.push(`Skills match: +${skillPoints}pts (${crossCategoryMatched.length}/${projectSkills.length} skills)`);
  
  // Client reliability (up to 15 points)
  if (project.client?.paymentVerified) {
    confidence += 5;
    confidenceBreakdown.push('Payment verified: +5pts');
  }
  if (project.client?.totalSpent > 10000) {
    confidence += 5;
    confidenceBreakdown.push(`High spender ($${(project.client.totalSpent/1000).toFixed(0)}k): +5pts`);
  }
  if (project.client?.feedbackRate >= 4.5) {
    confidence += 5;
    confidenceBreakdown.push(`Good rating (${project.client.feedbackRate}★): +5pts`);
  }
  
  // Budget alignment (up to 10 points)
  if (offering && project.budgetMax > 0) {
    const avgRate = (offering.rateMin + offering.rateMax) / 2;
    if (project.isHourly && project.budgetMax >= avgRate * 0.8) {
      confidence += 10;
      confidenceBreakdown.push('Budget aligns with our rates: +10pts');
    } else if (!project.isHourly && project.budgetMax >= avgRate * 15) {
      confidence += 10;
      confidenceBreakdown.push('Fixed budget adequate: +10pts');
    }
  }
  
  confidence = Math.min(Math.max(Math.round(confidence), 20), 95);
  
  const avgRate = offering ? Math.round((offering.rateMin + offering.rateMax) / 2) : 100;
  const estimatedHours = project.estimatedHours || 20;
  const estimatedCostMin = estimatedHours * (offering?.rateMin || 75);
  const estimatedCostMax = estimatedHours * (offering?.rateMax || 120);
  
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2500,
        messages: [{ 
          role: 'user', 
          content: `Analyze this Upwork project and generate a professional proposal.

PROJECT DETAILS:
Title: ${project.title}
Description: ${project.description}
Required Skills: ${project.skills?.join(', ') || 'Not specified'}
Client Budget: ${project.budget}
Client Country: ${project.country || 'Not specified'}
Client Total Spent on Upwork: $${project.client?.totalSpent?.toLocaleString() || '0'}
Client Hire Rate: ${project.client?.hireRate || 'N/A'}%
Client Rating: ${project.client?.feedbackRate || 'N/A'}★
Experience Level Required: ${project.experienceLevel || 'Not specified'}

OUR CAPABILITIES:
Service Category: ${offering?.name || 'General'}
Our Skills (this category): ${offering?.skills?.join(', ') || 'Various'}
Our Skills (all categories): ${uniqueOurSkills.slice(0, 20).join(', ')}
Rate Range: $${offering?.rateMin || 75}-$${offering?.rateMax || 120}/hr
Skills We Have for This Project: ${crossCategoryMatched.join(', ') || 'General experience'}
Skills We're Missing: ${crossCategoryMissing.join(', ') || 'None identified'}

CONFIDENCE ANALYSIS:
Current Score: ${confidence}%
Breakdown:
${confidenceBreakdown.join('\n')}

PROPOSAL TEMPLATE TO FOLLOW:
${template || 'Write a professional, personalized proposal.'}

Please analyze and return ONLY valid JSON (no markdown):
{
  "proposal": "The complete proposal text ready to submit. Use actual line breaks for formatting. Be specific to this project, mention their requirements, and explain why we're a good fit.",
  "analysis": {
    "projectSummary": "2-3 sentence summary of what the client actually needs and their goals",
    "estimatedHours": ${estimatedHours},
    "complexity": "Low or Medium or High - based on scope and technical requirements",
    "recommendedRate": ${avgRate},
    "totalEstimateMin": ${estimatedCostMin},
    "totalEstimateMax": ${estimatedCostMax},
    "confidenceScore": ${confidence},
    "confidenceBreakdown": ${JSON.stringify(confidenceBreakdown)},
    "skillsMatched": ${JSON.stringify(crossCategoryMatched)},
    "skillsMissing": ${JSON.stringify(crossCategoryMissing)},
    "recommendation": "STRONG BID or BID or CONSIDER or SKIP - based on fit and profitability",
    "recommendationReason": "Specific reason why you recommend this action",
    "keyDeliverables": ["deliverable 1", "deliverable 2", "deliverable 3"],
    "risks": ["potential risk 1", "potential risk 2"],
    "timeline": "Realistic timeline estimate like '1-2 weeks' or '2-3 weeks'",
    "questionsForClient": ["Question 1 to clarify scope?", "Question 2?"]
  }
}`
        }]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anthropic API error:', errorText);
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json();
    const text = data.content?.find(i => i.type === 'text')?.text || '';
    
    let proposalData;
    try {
      // Clean up the response
      let cleanText = text.trim();
      if (cleanText.startsWith('```json')) cleanText = cleanText.slice(7);
      if (cleanText.startsWith('```')) cleanText = cleanText.slice(3);
      if (cleanText.endsWith('```')) cleanText = cleanText.slice(0, -3);
      proposalData = JSON.parse(cleanText.trim());
    } catch (parseError) {
      console.error('JSON parse error:', parseError.message);
      // Return a fallback response
      proposalData = {
        proposal: text || "Unable to generate proposal. Please try again.",
        analysis: {
          projectSummary: project.description?.slice(0, 300) || 'Project analysis pending',
          estimatedHours: estimatedHours,
          complexity: projectSkills.length > 5 ? 'High' : projectSkills.length > 2 ? 'Medium' : 'Low',
          recommendedRate: avgRate,
          totalEstimateMin: estimatedCostMin,
          totalEstimateMax: estimatedCostMax,
          confidenceScore: confidence,
          confidenceBreakdown: confidenceBreakdown,
          skillsMatched: crossCategoryMatched,
          skillsMissing: crossCategoryMissing,
          recommendation: confidence >= 75 ? 'BID' : confidence >= 60 ? 'CONSIDER' : 'REVIEW',
          recommendationReason: `Based on ${confidence}% confidence score`,
          keyDeliverables: ['Project deliverables to be discussed'],
          risks: ['Scope clarification needed'],
          timeline: `${Math.ceil(estimatedHours / 40)} weeks estimated`,
          questionsForClient: ['Can you clarify the project scope?']
        }
      };
    }
    
    // Ensure confidence breakdown is included
    if (proposalData.analysis && !proposalData.analysis.confidenceBreakdown) {
      proposalData.analysis.confidenceBreakdown = confidenceBreakdown;
    }
    
    res.json({ success: true, ...proposalData });
    
  } catch (error) {
    console.error('Proposal generation error:', error.message);
    res.status(500).json({ 
      error: error.message,
      // Return partial analysis even on error
      analysis: {
        projectSummary: project.description?.slice(0, 300) || 'Error analyzing project',
        estimatedHours: estimatedHours,
        complexity: 'Unknown',
        recommendedRate: avgRate,
        totalEstimateMin: estimatedCostMin,
        totalEstimateMax: estimatedCostMax,
        confidenceScore: confidence,
        confidenceBreakdown: confidenceBreakdown,
        skillsMatched: crossCategoryMatched,
        skillsMissing: crossCategoryMissing,
        recommendation: 'REVIEW',
        recommendationReason: 'Error occurred during analysis',
        keyDeliverables: [],
        risks: ['Analysis error - manual review required'],
        timeline: 'TBD',
        questionsForClient: []
      }
    });
  }
});

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
    
    const jobs = await runApifyActor(input);
    const responseData = { success: true, keyword, count: jobs.length, jobs, timestamp: new Date().toISOString() };
    setCache(cacheKey, responseData);
    res.json(responseData);
  } catch (error) {
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
    
    const jobs = await runApifyActor(input);
    const responseData = { success: true, keywords, count: jobs.length, jobs, timestamp: new Date().toISOString() };
    setCache(cacheKey, responseData);
    res.json(responseData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`PaysonTech Upwork Tracker API v2.1.0 on port ${PORT}`);
  console.log(`Apify: ${APIFY_API_TOKEN ? '✓' : '✗'} | Anthropic: ${ANTHROPIC_API_KEY ? '✓' : '✗'}`);
});
