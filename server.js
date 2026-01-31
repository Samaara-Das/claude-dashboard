const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = 3847;

// Claude data paths
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATS_CACHE = path.join(CLAUDE_DIR, 'stats-cache.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Parse JSONL file
function parseJSONL(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').filter(line => line.trim()).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// Get project name from path
function extractProjectName(dirName) {
  // Convert directory name back to readable project name
  const parts = dirName.replace(/^[A-Za-z]--/, '').split('-');
  // Find the project name (last meaningful part)
  const idx = parts.findIndex(p => p === 'Users' || p === 'Work' || p === 'Coding' || p === 'OneDrive' || p === 'Desktop');
  if (idx === -1) return dirName;
  return parts.slice(-1)[0] || parts.slice(-2).join('-');
}

// API: Get stats summary
app.get('/api/stats', (req, res) => {
  try {
    const stats = JSON.parse(fs.readFileSync(STATS_CACHE, 'utf8'));
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read stats', details: e.message });
  }
});

// API: Get projects summary
app.get('/api/projects', (req, res) => {
  try {
    const projects = fs.readdirSync(PROJECTS_DIR)
      .filter(d => fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory())
      .map(dir => {
        const projectPath = path.join(PROJECTS_DIR, dir);
        const sessions = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
        
        // Get session details
        let totalMessages = 0;
        let totalToolCalls = 0;
        let lastActivity = null;
        let branches = new Set();
        
        sessions.forEach(sessionFile => {
          const sessionPath = path.join(projectPath, sessionFile);
          try {
            const stat = fs.statSync(sessionPath);
            if (!lastActivity || stat.mtime > lastActivity) {
              lastActivity = stat.mtime;
            }
            
            const entries = parseJSONL(sessionPath);
            entries.forEach(entry => {
              if (entry.type === 'user' || entry.type === 'assistant') totalMessages++;
              if (entry.gitBranch) branches.add(entry.gitBranch);
              if (entry.message?.content) {
                const content = typeof entry.message.content === 'string' 
                  ? entry.message.content 
                  : JSON.stringify(entry.message.content);
                const toolMatches = content.match(/tool_use|function_call/g);
                if (toolMatches) totalToolCalls += toolMatches.length;
              }
            });
          } catch {}
        });
        
        return {
          name: extractProjectName(dir),
          fullPath: dir,
          sessionCount: sessions.length,
          totalMessages,
          totalToolCalls,
          lastActivity: lastActivity ? lastActivity.toISOString() : null,
          branches: Array.from(branches)
        };
      })
      .sort((a, b) => b.sessionCount - a.sessionCount);
    
    res.json(projects);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read projects', details: e.message });
  }
});

// API: Get recent history
app.get('/api/history', (req, res) => {
  try {
    const entries = parseJSONL(HISTORY_FILE);
    const limit = parseInt(req.query.limit) || 100;
    
    // Group by date
    const byDate = {};
    entries.slice(-limit).forEach(entry => {
      if (entry.timestamp) {
        const date = new Date(entry.timestamp).toISOString().split('T')[0];
        if (!byDate[date]) byDate[date] = [];
        byDate[date].push({
          display: entry.display?.slice(0, 200) || '',
          project: entry.project,
          timestamp: entry.timestamp,
          sessionId: entry.sessionId
        });
      }
    });
    
    res.json(byDate);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read history', details: e.message });
  }
});

// API: Get session details
app.get('/api/session/:project/:sessionId', (req, res) => {
  try {
    const { project, sessionId } = req.params;
    const sessionPath = path.join(PROJECTS_DIR, project, `${sessionId}.jsonl`);
    
    if (!fs.existsSync(sessionPath)) {
      // Try finding agent file
      const agentPath = path.join(PROJECTS_DIR, project, `agent-${sessionId.slice(0, 8)}.jsonl`);
      if (fs.existsSync(agentPath)) {
        const entries = parseJSONL(agentPath);
        return res.json(entries);
      }
      return res.status(404).json({ error: 'Session not found' });
    }
    
    const entries = parseJSONL(sessionPath);
    res.json(entries);
  } catch (e) {
    res.status(500).json({ error: 'Failed to read session', details: e.message });
  }
});

// API: Get activity timeline (last 7 days)
app.get('/api/timeline', (req, res) => {
  try {
    const stats = JSON.parse(fs.readFileSync(STATS_CACHE, 'utf8'));
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    // Get recent activity from all project sessions
    const recentActivity = [];
    const projects = fs.readdirSync(PROJECTS_DIR).filter(d => 
      fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory()
    );
    
    projects.forEach(project => {
      const projectPath = path.join(PROJECTS_DIR, project);
      const sessions = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
      
      sessions.forEach(sessionFile => {
        const sessionPath = path.join(projectPath, sessionFile);
        try {
          const stat = fs.statSync(sessionPath);
          if (stat.mtime > sevenDaysAgo) {
            const entries = parseJSONL(sessionPath);
            const userMsgs = entries.filter(e => e.type === 'user' && e.message);
            
            recentActivity.push({
              project: extractProjectName(project),
              sessionId: sessionFile.replace('.jsonl', ''),
              messageCount: userMsgs.length,
              lastModified: stat.mtime.toISOString(),
              samplePrompts: userMsgs.slice(-3).map(e => 
                (e.display || e.message?.content || '').slice(0, 100)
              ).filter(Boolean)
            });
          }
        } catch {}
      });
    });
    
    // Combine with cached daily stats
    const timeline = {
      cachedStats: stats.dailyActivity || [],
      recentSessions: recentActivity.sort((a, b) => 
        new Date(b.lastModified) - new Date(a.lastModified)
      ).slice(0, 20),
      tokensByDay: stats.dailyModelTokens || [],
      hourlyDistribution: stats.hourCounts || {}
    };
    
    res.json(timeline);
  } catch (e) {
    res.status(500).json({ error: 'Failed to build timeline', details: e.message });
  }
});

// API: Get summary for dashboard header
app.get('/api/summary', (req, res) => {
  try {
    const stats = JSON.parse(fs.readFileSync(STATS_CACHE, 'utf8'));
    
    // Calculate model costs (approximate)
    const modelCosts = {};
    Object.entries(stats.modelUsage || {}).forEach(([model, usage]) => {
      const inputCost = (usage.inputTokens / 1000000) * (model.includes('opus') ? 15 : 3);
      const outputCost = (usage.outputTokens / 1000000) * (model.includes('opus') ? 75 : 15);
      const cacheCost = (usage.cacheReadInputTokens / 1000000) * (model.includes('opus') ? 1.5 : 0.3);
      modelCosts[model] = {
        inputCost: inputCost.toFixed(2),
        outputCost: outputCost.toFixed(2),
        cacheCost: cacheCost.toFixed(2),
        totalCost: (inputCost + outputCost + cacheCost).toFixed(2),
        ...usage
      };
    });
    
    // Count projects
    const projectCount = fs.readdirSync(PROJECTS_DIR)
      .filter(d => fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory()).length;
    
    res.json({
      totalSessions: stats.totalSessions,
      totalMessages: stats.totalMessages,
      firstSession: stats.firstSessionDate,
      longestSession: stats.longestSession,
      projectCount,
      modelUsage: modelCosts,
      lastComputed: stats.lastComputedDate
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get summary', details: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🦊 Claude Dashboard running at http://localhost:${PORT}`);
});
