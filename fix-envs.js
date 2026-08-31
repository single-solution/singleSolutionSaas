const fs = require('fs');
const path = require('path');

function replaceInFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let original = content;

  // Replace NEXT_PUBLIC_ in env variables
  content = content.replace(/SSO_SECRET/g, 'SSO_SECRET');
  content = content.replace(/PORTAL_URL/g, 'PORTAL_URL');
  content = content.replace(/ANALYTICS_URL/g, 'ANALYTICS_URL');

  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Updated', filePath);
  }
}

function traverseDir(dir) {
  if (dir.includes('node_modules') || dir.includes('.next') || dir.includes('.git')) return;
  
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      traverseDir(fullPath);
    } else {
      if (file.endsWith('.js') || file.endsWith('.jsx') || file.endsWith('.ts') || file.endsWith('.tsx') || file.startsWith('.env')) {
        replaceInFile(fullPath);
      }
    }
  }
}

traverseDir('.');
console.log('Done');
