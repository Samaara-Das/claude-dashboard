#!/usr/bin/env node

/**
 * 🦊 Claude Code Stats Generator - COMPREHENSIVE EDITION
 * 
 * Extracts ALL available data from Claude Code sessions for the past 6 months:
 * - Session details with messages, tools, tokens
 * - Model usage breakdown
 * - Tool/MCP statistics
 * - Daily/hourly activity patterns
 * - Project and git branch analysis
 * - Token consumption trends
 * - Cost estimates
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuration
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const OUTPUT_PATH = path.join(__dirname, 'public', 'data.json');
const SIX_MONTHS_AGO = new Date();
SIX_MONTHS_AGO.setMonth(SIX_MONTHS_AGO.getMonth() - 6);

// Pricing (approximate, per 1M tokens)
const PRICING = {
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-opus-4-5-20251101': { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  'default': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 }
};

console.log('🦊 Generating COMPREHENSIVE dashboard data...\n');

// Helper functions
function parseJsonl(filePath) {
  const lines = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (line.trim()) {
        try {
          lines.push(JSON.parse(line));
        } catch (e) { /* skip invalid lines */ }
      }
    }
  } catch (e) { /* file not readable */ }
  return lines;
}

function getDateStr(timestamp) {
  if (!timestamp) return null;
  const d = new Date(timestamp);
  return d.toISOString().split('T')[0];
}

function getHour(timestamp) {
  if (!timestamp) return null;
  return new Date(timestamp).getHours();
}

function getWeekday(timestamp) {
  if (!timestamp) return null;
  return new Date(timestamp).getDay(); // 0 = Sunday
}

// Main data collection
const data = {
  generatedAt: new Date().toISOString(),
  dateRange: { from: null, to: null, totalDays: 0 },
  
  // Summary stats
  summary: {
    totalSessions: 0,
    totalMessages: 0,
    totalToolCalls: 0,
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    estimatedCostUSD: 0,
    daysActive: 0,
    longestSession: { messages: 0, duration: 0 },
    averageSessionLength: 0,
    firstActivity: null,
    lastActivity: null
  },
  
  // Model breakdown
  modelUsage: {},
  
  // Tool statistics
  toolUsage: {},
  
  // Daily activity
  dailyActivity: [],
  
  // Hourly patterns (0-23)
  hourlyActivity: Array(24).fill(0),
  
  // Weekday patterns (0=Sun, 6=Sat)
  weekdayActivity: Array(7).fill(0),
  
  // Projects
  projects: [],
  
  // Git branches
  gitBranches: {},
  
  // Token trends over time
  tokenTrends: [],
  
  // Session details (limited for privacy)
  sessions: [],
  
  // Insights
  insights: []
};

// Read stats-cache.json for base stats
try {
  const statsCache = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'stats-cache.json'), 'utf-8'));
  
  data.summary.totalSessions = statsCache.totalSessions || 0;
  data.summary.totalMessages = statsCache.totalMessages || 0;
  
  if (statsCache.longestSession) {
    data.summary.longestSession = {
      messages: statsCache.longestSession.messageCount || 0,
      duration: statsCache.longestSession.duration || 0,
      date: statsCache.longestSession.timestamp
    };
  }
  
  if (statsCache.firstSessionDate) {
    data.summary.firstActivity = statsCache.firstSessionDate;
  }
  
  // Hourly activity from cache
  if (statsCache.hourCounts) {
    for (const [hour, count] of Object.entries(statsCache.hourCounts)) {
      data.hourlyActivity[parseInt(hour)] = count;
    }
  }
  
  // Model usage from cache
  if (statsCache.modelUsage) {
    for (const [model, usage] of Object.entries(statsCache.modelUsage)) {
      const shortName = model.includes('opus') ? 'Claude Opus 4.5' : 
                       model.includes('sonnet') ? 'Claude Sonnet 4.5' : model;
      data.modelUsage[shortName] = {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cacheRead: usage.cacheReadInputTokens || 0,
        cacheWrite: usage.cacheCreationInputTokens || 0,
        sessions: 0
      };
      
      data.summary.totalTokens.input += usage.inputTokens || 0;
      data.summary.totalTokens.output += usage.outputTokens || 0;
      data.summary.totalTokens.cacheRead += usage.cacheReadInputTokens || 0;
      data.summary.totalTokens.cacheWrite += usage.cacheCreationInputTokens || 0;
    }
  }
  
  // Daily activity from cache
  if (statsCache.dailyActivity) {
    data.dailyActivity = statsCache.dailyActivity.map(d => ({
      date: d.date,
      messages: d.messageCount,
      sessions: d.sessionCount,
      toolCalls: d.toolCallCount
    }));
    
    // Sum up tool calls
    data.summary.totalToolCalls = statsCache.dailyActivity.reduce((sum, d) => sum + (d.toolCallCount || 0), 0);
    
    // Date range
    const dates = statsCache.dailyActivity.map(d => d.date).sort();
    if (dates.length > 0) {
      data.dateRange.from = dates[0];
      data.dateRange.to = dates[dates.length - 1];
      data.dateRange.totalDays = dates.length;
      data.summary.daysActive = dates.length;
    }
  }
  
  // Token trends from cache
  if (statsCache.dailyModelTokens) {
    data.tokenTrends = statsCache.dailyModelTokens.map(d => ({
      date: d.date,
      tokens: Object.values(d.tokensByModel || {}).reduce((sum, t) => sum + t, 0),
      byModel: d.tokensByModel
    }));
  }
  
  console.log('✅ Loaded stats-cache.json');
} catch (e) {
  console.log('⚠️  Could not load stats-cache.json:', e.message);
}

// Scan all project session files for detailed data
const projectsDir = path.join(CLAUDE_DIR, 'projects');
const projectMap = new Map();
const allSessionDates = new Set();
const toolCounts = {};
const branchCounts = {};

try {
  const projectDirs = fs.readdirSync(projectsDir);
  
  for (const projectDir of projectDirs) {
    const projectPath = path.join(projectsDir, projectDir);
    const stat = fs.statSync(projectPath);
    
    if (!stat.isDirectory()) {
      // It's a session file
      if (projectDir.endsWith('.jsonl')) {
        const sessionData = parseJsonl(projectPath);
        processSession(sessionData, projectDir, null);
      }
      continue;
    }
    
    // Extract project name from directory
    const projectName = projectDir.replace(/^[A-Z]-+/g, '').replace(/-/g, ' ').trim();
    
    // Initialize project stats
    if (!projectMap.has(projectDir)) {
      projectMap.set(projectDir, {
        name: projectName,
        path: projectDir,
        sessions: 0,
        messages: 0,
        toolCalls: 0,
        branches: new Set(),
        lastActivity: null
      });
    }
    
    // Read session files in project
    const files = fs.readdirSync(projectPath);
    for (const file of files) {
      if (file.endsWith('.jsonl')) {
        const sessionPath = path.join(projectPath, file);
        const sessionData = parseJsonl(sessionPath);
        processSession(sessionData, file, projectMap.get(projectDir));
      }
    }
  }
  
  console.log(`✅ Processed ${projectMap.size} projects`);
} catch (e) {
  console.log('⚠️  Could not scan projects:', e.message);
}

function processSession(lines, filename, project) {
  let sessionMessages = 0;
  let sessionToolCalls = 0;
  let sessionStart = null;
  let sessionEnd = null;
  let branch = null;
  
  for (const line of lines) {
    // Track timestamps
    if (line.timestamp) {
      const ts = new Date(line.timestamp);
      if (ts >= SIX_MONTHS_AGO) {
        allSessionDates.add(getDateStr(line.timestamp));
        
        // Update hourly/weekday activity
        const hour = getHour(line.timestamp);
        const weekday = getWeekday(line.timestamp);
        if (hour !== null) data.hourlyActivity[hour]++;
        if (weekday !== null) data.weekdayActivity[weekday]++;
        
        if (!sessionStart || ts < sessionStart) sessionStart = ts;
        if (!sessionEnd || ts > sessionEnd) sessionEnd = ts;
        
        if (!data.summary.lastActivity || ts > new Date(data.summary.lastActivity)) {
          data.summary.lastActivity = line.timestamp;
        }
      }
    }
    
    // Count messages
    if (line.type === 'user' || line.type === 'assistant') {
      sessionMessages++;
    }
    
    // Track git branch
    if (line.gitBranch && !branch) {
      branch = line.gitBranch;
      branchCounts[branch] = (branchCounts[branch] || 0) + 1;
    }
    
    // Count tool calls from assistant messages
    if (line.type === 'assistant' && line.message?.content) {
      const content = line.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            sessionToolCalls++;
            const toolName = block.name || 'unknown';
            toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
          }
        }
      }
    }
    
    // Track model usage
    if (line.message?.model) {
      const model = line.message.model;
      const shortName = model.includes('opus') ? 'Claude Opus 4.5' : 
                       model.includes('sonnet') ? 'Claude Sonnet 4.5' : model;
      if (!data.modelUsage[shortName]) {
        data.modelUsage[shortName] = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, sessions: 0 };
      }
      data.modelUsage[shortName].sessions++;
    }
  }
  
  // Update project stats
  if (project) {
    project.sessions++;
    project.messages += sessionMessages;
    project.toolCalls += sessionToolCalls;
    if (branch) project.branches.add(branch);
    if (sessionEnd && (!project.lastActivity || sessionEnd > new Date(project.lastActivity))) {
      project.lastActivity = sessionEnd.toISOString();
    }
  }
}

// Build tool usage data
data.toolUsage = Object.entries(toolCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .reduce((obj, [name, count]) => {
    obj[name] = count;
    return obj;
  }, {});

// Build git branches data
data.gitBranches = Object.entries(branchCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)
  .reduce((obj, [name, count]) => {
    obj[name] = count;
    return obj;
  }, {});

// Build projects list
data.projects = Array.from(projectMap.values())
  .map(p => ({
    name: p.name,
    sessions: p.sessions,
    messages: p.messages,
    toolCalls: p.toolCalls,
    branches: Array.from(p.branches).slice(0, 5),
    lastActivity: p.lastActivity
  }))
  .filter(p => p.sessions > 0)
  .sort((a, b) => b.sessions - a.sessions)
  .slice(0, 10);

// Calculate estimated cost
for (const [model, usage] of Object.entries(data.modelUsage)) {
  const pricing = model.includes('Opus') ? PRICING['claude-opus-4-5-20251101'] : PRICING['default'];
  const cost = 
    (usage.inputTokens / 1_000_000) * pricing.input +
    (usage.outputTokens / 1_000_000) * pricing.output +
    (usage.cacheRead / 1_000_000) * pricing.cacheRead +
    (usage.cacheWrite / 1_000_000) * pricing.cacheWrite;
  data.summary.estimatedCostUSD += cost;
}

// Calculate average session length
if (data.summary.totalSessions > 0) {
  data.summary.averageSessionLength = Math.round(data.summary.totalMessages / data.summary.totalSessions);
}

// Generate insights
const insights = [];

// Most productive day
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const maxWeekday = data.weekdayActivity.indexOf(Math.max(...data.weekdayActivity));
insights.push(`📅 Most active day: ${weekdays[maxWeekday]}`);

// Peak coding hours
const maxHour = data.hourlyActivity.indexOf(Math.max(...data.hourlyActivity));
insights.push(`⏰ Peak coding hour: ${maxHour}:00-${maxHour + 1}:00`);

// Top project
if (data.projects.length > 0) {
  insights.push(`🏆 Top project: ${data.projects[0].name} (${data.projects[0].sessions} sessions)`);
}

// Tool usage
const topTool = Object.entries(data.toolUsage)[0];
if (topTool) {
  insights.push(`🔧 Most used tool: ${topTool[0]} (${topTool[1].toLocaleString()} calls)`);
}

// Model preference
const models = Object.entries(data.modelUsage).sort((a, b) => b[1].outputTokens - a[1].outputTokens);
if (models.length > 0) {
  insights.push(`🤖 Primary model: ${models[0][0]}`);
}

// Tokens generated
const totalTokensOut = data.summary.totalTokens.output;
if (totalTokensOut > 0) {
  const words = Math.round(totalTokensOut * 0.75); // rough token-to-word ratio
  insights.push(`✍️ ~${(words / 1000).toFixed(0)}K words generated`);
}

// Cost insight
if (data.summary.estimatedCostUSD > 0) {
  insights.push(`💰 Estimated cost: $${data.summary.estimatedCostUSD.toFixed(2)}`);
}

// Streak/consistency
if (data.dateRange.totalDays > 0) {
  insights.push(`🔥 Active on ${data.dateRange.totalDays} days`);
}

data.insights = insights;

// Write output
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));

console.log(`\n✅ Data written to ${OUTPUT_PATH}\n`);
console.log('📊 Stats:');
console.log(`   - ${data.summary.totalSessions} sessions`);
console.log(`   - ${data.summary.totalMessages.toLocaleString()} messages`);
console.log(`   - ${data.summary.totalToolCalls.toLocaleString()} tool calls`);
console.log(`   - ${data.projects.length} projects`);
console.log(`   - ${Object.keys(data.gitBranches).length} git branches`);
console.log(`   - ${Object.keys(data.toolUsage).length} tools tracked`);
console.log(`   - ${data.dateRange.totalDays} days of activity`);
console.log(`   - ~$${data.summary.estimatedCostUSD.toFixed(2)} estimated cost`);
console.log(`\n🚀 Ready to deploy!`);
