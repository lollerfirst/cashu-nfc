import fs from 'fs-extra';
import path from 'path';
import sqlite3 from 'sqlite3';
import { NFC } from 'nfc-pcsc';
import process from 'node:process';
import inquirer from 'inquirer';
import { readCard, writeCard } from '../common/nfc.js';
import { getDecodedToken, CashuWallet, CashuMint, getEncodedTokenV4 } from '@cashu/cashu-ts';
import { compileToken } from '../common/helpers.js';
import qrcode from 'qrcode-terminal';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

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
const dbPath = config.sqlite_path;

fs.ensureFile(dbPath)
.catch(err => {
  console.error(err)
  process.exit(1);
})

let db;
try {
  db = new sqlite3.Database(dbPath);
  console.log(`Successfully loaded SQLite database at ${dbPath}`);
} catch (err) {
  console.error(`Error opening SQLite database: ${err}`);
  process.exit(1);
}

// Create the database schema if it does not exist
db.serialize(function() {
  db.run(`
    CREATE TABLE IF NOT EXISTS proofs (
      signature TEXT NOT NULL PRIMARY KEY,
      keyset TEXT NOT NULL,
      secret TEXT NOT NULL,
      amount INTEGER NOT NULL,
      mint TEXT NOT NULL,
      unit TEXT NOT NULL
    )
  `);
});

const persistProofs = function (proofs, mint, unit) {
  for (const p of proofs) {
    db.run('INSERT INTO proofs (signature, keyset, secret, amount, mint, unit) VALUES (?, ?, ?, ?, ?, ?)',
      [p.C, p.id, p.secret, p.amount, mint, unit], (err) => {
        if (err) {
          console.error(err);
        }
      });
  }
}

const loadProofsFromDB = function (mint, unit) {
  return new Promise( (resolve, reject) => {
    const sql = 'SELECT * FROM proofs WHERE mint = ? AND unit = ?;';
    const proofs = [];
    db.all(sql, [mint, unit], (err, rows) => {
      if (err) {
        console.error(err);
        reject(err);
      } else {
        for (const row of rows)
          proofs.push({id: row.keyset, amount: row.amount, secret: row.secret, C: row.signature});
        resolve(proofs);
      }
    });
  });
}

const validateIntegerInput = function (input) {
  const num = parseInt(input);
  if (isNaN(num) || num <= 0) {
      return 'Please enter a valid integer.';
  }
  return true;
}

const waitForCard = function (nfc) {
  return new Promise((resolve, reject) => {
    nfc.on('reader', (reader) => {
      reader.on('card', (card) => {
        resolve({reader, card});
      });
      reader.on('error', (err) => {
        console.error(`An error occurred: ${err}`);
        reject(err);
      });
      reader.on('end', () => {
        console.error(`${reader.reader.name}  card removed`);
      });
    });
  });
}

const requestPayment = async function () {
  const response = await inquirer.prompt([
    {
        type: 'input',
        name: 'amount',
        message: 'Enter an amount:',
        validate: validateIntegerInput,
    }
  ]);
  const nfc = new NFC();
  const amount = response.amount;
  console.log("Waiting for card...")
  const { reader } = await waitForCard(nfc);

  const tokenString = await readCard(reader);
  const token = getDecodedToken(tokenString);
  const proofs = token.token[0].proofs;
  const proofsAmount = proofs.reduce((curr, p) => p.amount + curr, 0);
  if (proofsAmount < amount) {
    throw new Error('Card not sufficiently funded');
  }
  
  // Create a new wallet
  const mint = new CashuMint(token.token[0].mint);
  const wallet = new CashuWallet(mint, { unit: token.unit ?? 'sat' });
  try {
      const mintInfo = await wallet.getMintInfo();
      console.log(`mintInfo: ${mintInfo.name} online!`);
  } catch (err) {
      console.error(`Couldn't contact mint: ${err}`);
      throw new Error(err);
  }
  
  // Swap if the mint is in our trusted mints list
  if (config.trusted_mints.includes(token.token[0].mint)) {
    const { returnChange, send } = await wallet.send(amount, proofs);

    // We pocket the amount we requested
    persistProofs(send, token.token[0].mint, token.unit ?? 'sat');
    console.log("\x1b[1;32m" + `PAYMENT SUCCESSFUL: ${amount} ${token.unit ?? 'sats'}` + "\x1b[0m");

    // Return the change into the card
    const amountChange = returnChange.reduce((acc, p) => p.amount + acc, 0);
    const changeToken = compileToken(wallet.mint.mintUrl, wallet.unit, returnChange);
    const changeTokenString = getEncodedTokenV4(changeToken);
    try {
      await writeCard(reader, changeTokenString);
      console.log(`Successfully returned ${amountChange} ${wallet.unit} of change`)
    } catch {
      console.error("Could not return the change in the card!");
      console.log(`Here's a cashu token for ${amountChange} ${wallet.unit} of change instead:`)
      qrcode.generate(changeTokenString, { small: true }, (qr) => {
        console.log(qr);
        console.log(changeTokenString);
      });
    }
  } else {
    // Temporary rejection behaviour -- Unimplemented yet
    throw new Error(`mint ${token.token[0].mint} is not a trusted mint!`);
  }
}

const cashOut = async function () {
  const response = await inquirer.prompt([
    {
        type: 'list',
        name: 'mint',
        message: 'Select the mint for the cashout:',
        choices: config.trusted_mints,
    },
    {
        type: 'list',
        name: 'unit',
        message: 'Select the currency:',
        choices: config.supported_units,
    },
    {
        type: 'input',
        name: 'amount',
        message: 'How much do you want to cash out?',
        validate: validateIntegerInput,
    }
  ]);

  const proofs = await loadProofsFromDB(response.mint, response.unit);
  const balance = proofs.reduce((acc, p) => p.amount + acc, 0);
  console.log(`Cash balance amounts to ${balance} sats`);

  if (response.amount > balance) {
    throw new Error('Insufficient Balance');
  }

  const mint = new CashuMint(response.mint);
  const wallet = new CashuWallet(mint, { unit: response.unit });
  const { returnChange, send } = await wallet.send(response.amount, proofs);

  persistProofs(returnChange, wallet.mint, wallet.unit);
  
  const token = compileToken(wallet.mint, wallet.unit, send);
  const tokenString = getEncodedTokenV4(token);

  console.log("Here's your token:");
  qrcode.generate(tokenString, { small: true }, (qr) => {
    console.log(qr);
    console.log(tokenString);
  });

  console.log("\x1b[1;32m" + `SUCCESSFULLY CASHED OUT: ${response.amount} ${response.unit}` + "\x1b[0m");
}

let exit = false;
while (!exit) {
  const response = await inquirer.prompt([
    {
        type: 'list',
        name: 'choice',
        message: 'What do you want to do?',
        choices: ["Request Payment", "Cash Out", "Exit"],
    }
  ]);

  try {
    switch (response.choice) {
      case "Request Payment":
        await requestPayment();
        break;
      case "Cash Out":
        await cashOut();
        break;
      case "Exit":
        process.exit(0);
        break;
      default:
        console.error("Invalid option!");
    }
  } catch (err) {
    console.error("\x1b[1;31m" + `ERROR: ${err}` + "\x1b[0m");
  }
}

db.close();
