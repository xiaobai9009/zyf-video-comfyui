const fs = require('fs');
const vm = require('vm');
const f = process.argv[2];
const c = fs.readFileSync(f, 'utf8');
const s = c
    .replace(/^import\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^import\s+\w+\s+from\s*['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^import\s+\*\s+as\s+\w+\s+from\s*['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^import\s*['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+(async\s+)?function\s+/gm, 'function ')
    .replace(/^export\s+default\s+/gm, '')
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+/gm, '')
    .replace(/import\.meta\.url/g, '"file://"');
new vm.Script(s, { filename: f });
console.log(f + ' OK');