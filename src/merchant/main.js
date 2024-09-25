import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import nfc from 'nfc-pcsc';
import process from 'node:process';


// Load the configuration file
const configPath = path.join(__dirname, 'merchant.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`Error loading configuration file: ${err}`);
  process.exit(1);
}

// Check for the sqlite_path field
if (!config.sqlite_path) {
  console.error('sqlite_path field is missing from the configuration file');
  process.exit(1);
}

// Try to open the SQLite database
const dbPath = path.join(__dirname, config.sqlite_path);
let db;
try {
  db = new sqlite3.Database(dbPath);
} catch (err) {
  // If the database does not exist, create it
  if (err.code === 'ENOENT') {
    console.log(`Creating SQLite database at ${dbPath}`);
    db = new sqlite3.Database(dbPath);
  } else {
    console.error(`Error opening SQLite database: ${err}`);
    process.exit(1);
  }
}

// Create the database schema if it does not exist
db.serialize(function() {
  db.run(`
    CREATE TABLE IF NOT EXISTS proofs (
      signature TEXT NOT NULL PRIMARY KEY,
      keyset TEXT NOT NULL,
      secret TEXT NOT NULL,
      amount INTEGER NOT NULL
    )
  `);
});


// Scan for connected NFC devices
nfc.on('reader', (reader) => {
    console.log(`NFC reader connected: ${reader.name}`);
    reader.autoProcessing = false;

    // Set up the reader to scan for new NFC cards
    reader.on('card', async (card) => {
        console.log();
		    console.log(`card detected`, card);
        try{
            const data = await reader.read(4, 12);
            console.log(`NFC card detected: ${data}`);

            // Process the NFC card
            // processCard(card.uid);
        } catch (err) {
            console.error(`error when writing data`, err);
        }
    });

    // Set up the reader to handle errors
    reader.on('error', (err) => {
        console.error(`NFC reader error: ${err}`);
    });

    // Set up the reader behaviour when card is remove
    reader.on('end', () => {
        console.log(`${reader.reader.name}  card removed`);
    });
});
  
// Handle the case where no NFC devices are connected
nfc.on('error', (err) => {
console.error(`Error connecting to NFC device: ${err}`);
process.exit(1);
});

setInterval(() => {
  // Do nothing, just keep the program running
}, 1000);

db.close();
