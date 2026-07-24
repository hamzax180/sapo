const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, 'public');

function replaceInDir(dirPath) {
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      replaceInDir(fullPath);
    } else if (file.endsWith('.html') || file.endsWith('.js') || file.endsWith('.css')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      const original = content;
      content = content.replace(/login\.html/g, 'login');
      content = content.replace(/signup\.html/g, 'signup');
      content = content.replace(/pricing\.html/g, 'pricing');
      content = content.replace(/checkout\.html/g, 'checkout');
      content = content.replace(/portal\.html/g, 'portal');
      content = content.replace(/index\.html/g, '/'); // index.html is root
      if (content !== original) {
        fs.writeFileSync(fullPath, content);
        console.log(`Updated ${fullPath}`);
      }
    }
  }
}

replaceInDir(dir);
