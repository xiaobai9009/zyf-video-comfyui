const fs = require('fs');
const path = 'C:\\Users\\Lenovo\\AppData\\Local\\Programs\\Python\\Python312\\Lib\\site-packages\\comfyui_frontend_package\\static\\assets\\dialogService-D6_DwdXo.js.map';
const content = fs.readFileSync(path, 'utf-8');
const map = JSON.parse(content);

map.sources.forEach((s, i) => {
  if (s.includes('domWidget')) {
    console.log(`Index ${i}: ${s}`);
  }
});
