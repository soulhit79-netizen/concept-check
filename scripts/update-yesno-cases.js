// scripts/update-yesno-cases.js - Update yes/no case prompts in database to ask for reason
require('dotenv').config();
const { getPool, closeDb } = require('../server/db');

async function updateYesNoCases() {
  const pool = getPool();
  const updates = [
    {
      theme: 'access control',
      sql: "UPDATE cases SET prompt = 'A frontend downloads every user''s profile and then hides everyone''s except the logged-in user''s. Is other users'' data private, and why or why not?' WHERE theme = 'access control';",
      newPrompt: "A frontend downloads every user's profile and then hides everyone's except the logged-in user's. Is other users' data private, and why or why not?"
    },
    {
      theme: 'hidden variable',
      sql: "UPDATE cases SET prompt = 'A developer stores their API key in a frontend environment variable called VITE_API_KEY, thinking it is hidden. Is it safe, and why or why not?' WHERE theme = 'hidden variable';",
      newPrompt: "A developer stores their API key in a frontend environment variable called VITE_API_KEY, thinking it is hidden. Is it safe, and why or why not?"
    },
    {
      theme: 'disguised key',
      sql: "UPDATE cases SET prompt = 'A developer splits the key into three pieces in the frontend code and joins them while the page runs, so nobody can find it. Can a visitor still get the full key, and how?' WHERE theme = 'disguised key';",
      newPrompt: "A developer splits the key into three pieces in the frontend code and joins them while the page runs, so nobody can find it. Can a visitor still get the full key, and how?"
    },
    {
      theme: 'login is not protection',
      sql: "UPDATE cases SET prompt = 'A developer says: ''Only my logged-in users can see the page, so the key in the code is safe.'' Is that right, and why or why not?' WHERE theme = 'login is not protection';",
      newPrompt: "A developer says: 'Only my logged-in users can see the page, so the key in the code is safe.' Is that right, and why or why not?"
    }
  ];

  console.log('--- Executing SQL Updates on Postgres Database ---');
  for (const u of updates) {
    console.log(u.sql);
    const res = await pool.query('UPDATE cases SET prompt = $1 WHERE theme = $2', [u.newPrompt, u.theme]);
    console.log(`  -> Status: ${res.rowCount} row(s) updated.`);
  }

  await closeDb();
  console.log('--- SQL Updates Complete ---');
}

updateYesNoCases().catch(err => {
  console.error('Update failed:', err);
  process.exit(1);
});
