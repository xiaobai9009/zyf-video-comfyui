const fs = require('fs');
const path = 'C:\\Users\\Lenovo\\AppData\\Local\\Programs\\Python\\Python312\\Lib\\site-packages\\comfyui_frontend_package\\static\\assets\\dialogService-D6_DwdXo.js.map';
const content = fs.readFileSync(path, 'utf-8');
const map = JSON.parse(content);

const idx = map.sources.findIndex(s => s.includes('domWidget.ts'));
console.log('domWidget.ts index:', idx);
fs.writeFileSync('D:\\AIAIAI\\ComfyUI_PyTorch291cu130\\ComfyUI\\custom_nodes\\zyf-video\\domWidget_script.txt', map.sourcesContent[idx]);
console.log('Saved domWidget.ts, length:', map.sourcesContent[idx].length);
