/**
 * Generate sanitized, privacy-safe data for public deployment
 * Run this locally to update data before deploying
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATS_CACHE = path.join(CLAUDE_DIR, 'stats-cache.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const OUTPUT_FILE = path.join(__dirname, 'public', 'data.json');

function parseJSONL(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').filter(line => line.trim()).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function sanitizeProjectName(dirName) {
  // Extract just the project name, remove personal paths
  const parts = dirName.replace(/^[A-Za-z]--/, '').split('-');
  const skipWords = ['Users', 'dassa', 'Work', 'Coding', 'OneDrive', 'Desktop', 'Documents'];
  const meaningful = parts.filter(p => !skipWords.includes(p) && p.length > 2);
  return meaningful.slice(-2).join('-') || 'Project';
}

function generateData() {
  console.log('🦊 Generating privacy-safe dashboard data...\n');
  
  // Read stats
  const stats = JSON.parse(fs.readFileSync(STATS_CACHE, 'utf8'));
  
  // Process projects (sanitized)
  const projects = fs.readdirSync(PROJECTS_DIR)
    .filter(d => fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory())
    .map(dir => {
      const projectPath = path.join(PROJECTS_DIR, dir);
      const sessions = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
      
      let totalMessages = 0;
      let lastActivity = null;
      
      sessions.forEach(sessionFile => {
        const sessionPath = path.join(projectPath, sessionFile);
        try {
          const stat = fs.statSync(sessionPath);
          if (!lastActivity || stat.mtime > lastActivity) lastActivity = stat.mtime;
          
          const entries = parseJSONL(sessionPath);
          entries.forEach(entry => {
            if (entry.type === 'user' || entry.type === 'assistant') totalMessages++;
          });
        } catch {}
      });
      
      return {
        name: sanitizeProjectName(dir),
        sessionCount: sessions.length,
        totalMessages,
        lastActivity: lastActivity ? lastActivity.toISOString().split('T')[0] : null
      };
    })
    .filter(p => p.sessionCount > 0)
    .sort((a, b) => b.sessionCount - a.sessionCount);
  
  // Calculate model costs (approximate)
  const modelUsage = {};
  Object.entries(stats.modelUsage || {}).forEach(([model, usage]) => {
    const shortName = model.includes('opus') ? 'Claude Opus' : 'Claude Sonnet';
    const inputCost = (usage.inputTokens / 1000000) * (model.includes('opus') ? 15 : 3);
    const outputCost = (usage.outputTokens / 1000000) * (model.includes('opus') ? 75 : 15);
    const cacheCost = (usage.cacheReadInputTokens / 1000000) * (model.includes('opus') ? 1.5 : 0.3);
    
    modelUsage[shortName] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      estimatedCost: (inputCost + outputCost + cacheCost).toFixed(2)
    };
  });
  
  // Calculate date range
  const dates = stats.dailyActivity?.map(d => d.date).sort() || [];
  const firstDate = dates[0] || null;
  const lastDate = dates[dates.length - 1] || null;
  
  // Build output (privacy-safe)
  const output = {
    generatedAt: new Date().toISOString(),
    dateRange: {
      from: firstDate,
      to: lastDate,
      totalDays: dates.length
    },
    summary: {
      totalSessions: stats.totalSessions,
      totalMessages: stats.totalMessages,
      projectCount: projects.length,
      daysSinceFirstSession: Math.floor((Date.now() - new Date(stats.firstSessionDate).getTime()) / (1000 * 60 * 60 * 24)),
      longestSessionHours: stats.longestSession ? Math.floor(stats.longestSession.duration / (1000 * 60 * 60)) : 0
    },
    dailyActivity: stats.dailyActivity || [],
    hourlyDistribution: stats.hourCounts || {},
    modelUsage,
    projects,
    // Fun stats
    funStats: {
      avgMessagesPerSession: Math.round(stats.totalMessages / stats.totalSessions),
      avgMessagesPerDay: Math.round(stats.totalMessages / Math.max(1, stats.dailyActivity?.length || 1)),
      peakDay: stats.dailyActivity?.reduce((max, d) => d.messageCount > (max?.messageCount || 0) ? d : max, null),
      totalToolCalls: stats.dailyActivity?.reduce((sum, d) => sum + (d.toolCallCount || 0), 0) || 0
    }
  };
  
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`✅ Data written to ${OUTPUT_FILE}`);
  console.log(`\n📊 Stats:`);
  console.log(`   - ${output.summary.totalSessions} sessions`);
  console.log(`   - ${output.summary.totalMessages} messages`);
  console.log(`   - ${output.summary.projectCount} projects`);
  console.log(`   - ${output.summary.daysSinceFirstSession} days of Claude usage`);
  console.log(`\n🚀 Ready to deploy!`);
}

generateData();
