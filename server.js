const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// A fresh machine — or a free hosting tier that wipes its disk on every deploy — boots to
// an empty database. Seed the demo school once so the showcase is never a blank page.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'school.db');
if (!fs.existsSync(DB_PATH)) {
  console.log('🎓 No database found — seeding the demo school…');
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'db', 'seed.js')], { stdio: 'inherit', env: process.env });
  } catch (err) {
    console.error('Seed failed:', err.message);
  }
}

const app = require('./src/app');
const config = require('./src/config');

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`🎓 ${config.schoolName} Portal running at http://localhost:${PORT}`);
  console.log('   Demo logins — admin/admin123 · teacher1…teacher13/teacher123 · parent1…parent40/parent123');
  console.log('   (A fictional demo school. No real student, staff or family data is included.)');
});
