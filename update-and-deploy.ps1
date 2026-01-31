# Update data and redeploy to Vercel
# Run this whenever you want to update your public dashboard

Write-Host "🦊 Updating Claude Dashboard..." -ForegroundColor Cyan

# Generate fresh data
node generate-data.js

# Deploy to Vercel
Write-Host "`n🚀 Deploying to Vercel..." -ForegroundColor Cyan
vercel --prod

Write-Host "`n✅ Done! Your dashboard is updated." -ForegroundColor Green
